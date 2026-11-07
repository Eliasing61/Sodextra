/**
 * Trade-only bot keys, created on the server and registered with the owner's
 * wallet signature (docs/security.md):
 *
 *   1. prepare   the server generates a key pair inside the vault (sealed, "pending")
 *                and returns the EIP-712 message for the owner's wallet to sign
 *   2. register  the server checks the signature is the owner's, submits it to SoDEX,
 *                and marks the key active once both engines list it
 *   3. test      a post-only order far below the market, then its cancel, both signed
 *                by the new key (proves trading and cancelling work; never fills)
 *
 * The private key never leaves the server and is never sent anywhere.
 */
import { randomBytes } from "node:crypto";

import { loadMarket } from "@sodextra/cli/market";
import { NOT_LISTED_YET, type KeyVault, type VaultKey } from "@sodextra/cli/vault";
import {
  ActionSigner,
  addPermissionedApiKeyTypedData,
  APIKeyPermission,
  minQuantityForNotional,
  OrderSide,
  OrderType,
  roundPrice,
  SodexClient,
  TimeInForce,
  toDecimal,
  type Network,
} from "@sodextra/sodex-client";
import { getAddress, verifyTypedData, type Address, type Hex } from "viem";

/** Trade only: placing and cancelling allowed (TRADE covers cancel); CANCEL-only, WITHDRAW and TRANSFER disabled. */
export const BOT_KEY_PERMISSIONS =
  APIKeyPermission.CANCEL | APIKeyPermission.WITHDRAW | APIKeyPermission.TRANSFER;
export const KEY_TTL_MS = 90 * 24 * 3600_000;
const PENDING_TTL_MS = 10 * 60_000;

export interface PreparedKey {
  id: string;
  name: string;
  address: Address;
  accountID: number;
  expiresAt: number;
  permissions: number;
  /** What the wallet signs (uint64 fields as decimal strings for JSON). */
  typedData: unknown;
}

export interface KeyResult {
  ok: boolean;
  message: string;
  /** "max-keys": SoDEX refused the key because the account has too many. */
  code?: "max-keys" | undefined;
  /** With "max-keys": earlier Sodextra keys on the account, safe to revoke. */
  oldKeys?: string[] | undefined;
  key?: PublicKey | undefined;
}

/** Shown when SoDEX refuses a new key because the account already has too many. */
export const MAX_KEYS_MESSAGE =
  "SoDEX says your account already has the most API keys it allows. Revoke one you no longer use on sodex.com, then create the bot key again.";

export type PublicKey = Omit<VaultKey, "owner">;

const pending = new Map<string, { nonce: bigint; chainId: number; until: number }>();

export function publicKey(k: VaultKey): PublicKey {
  return {
    id: k.id,
    name: k.name,
    address: k.address,
    accountId: k.accountId,
    permissions: k.permissions,
    expiresAt: k.expiresAt,
    status: k.status,
    note: k.note,
    createdAt: k.createdAt,
  };
}

/** Step 1: generate the key (sealed in the vault) and the message to sign. */
export async function prepareKey(
  vault: KeyVault,
  client: SodexClient,
  owner: Address,
  now = Date.now(),
): Promise<PreparedKey> {
  const state = await client.perps.state(owner);
  const accountID = Number(state.aid);
  if (!accountID)
    throw new Error("This wallet has no SoDEX account yet. Deposit on sodex.com first.");

  // No key-count check here: SoDEX's list also holds its own login keys (website, phone,
  // wallet apps) and expired ones, so counting it refused accounts SoDEX would accept.
  // If SoDEX does refuse for too many keys, registerKey says so (MAX_KEYS_MESSAGE).

  vault.prunePending(PENDING_TTL_MS, now);
  for (const [id, p] of pending) if (p.until < now) pending.delete(id);

  const date = new Date(now).toISOString().slice(0, 10).replaceAll("-", "");
  const name = `sodextra-${date}-${randomBytes(2).toString("hex")}`;
  const expiresAt = now + KEY_TTL_MS;
  const key = vault.createPending({
    name,
    owner,
    accountId: accountID,
    permissions: BOT_KEY_PERMISSIONS,
    expiresAt,
    now,
  });
  const nonce = BigInt(now);
  const chainId = client.network.chainId;
  pending.set(key.id, { nonce, chainId, until: now + PENDING_TTL_MS });

  const typed = typedDataFor(key, nonce, chainId);
  return {
    id: key.id,
    name,
    address: key.address,
    accountID,
    expiresAt,
    permissions: BOT_KEY_PERMISSIONS,
    typedData: JSON.parse(
      JSON.stringify(typed, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
    ),
  };
}

/** Step 2: check the owner's signature, register the key on SoDEX, confirm it's listed. */
export async function registerKey(
  vault: KeyVault,
  client: SodexClient,
  owner: Address,
  id: string,
  signature: Hex,
): Promise<KeyResult> {
  const key = vault.get(id);
  const p = pending.get(id);
  if (!key || !p || key.status !== "pending" || getAddress(key.owner) !== getAddress(owner)) {
    return { ok: false, message: "This key request expired. Start again." };
  }
  if (p.until < Date.now()) {
    pending.delete(id);
    return { ok: false, message: "This key request expired. Start again." };
  }

  const typed = typedDataFor(key, p.nonce, p.chainId);
  const valid = await verifyTypedData({ address: owner, ...typed, signature }).catch(() => false);
  if (!valid) return { ok: false, message: "The signature isn't from your wallet." };
  pending.delete(id);

  try {
    await client.user.addPermissionedApiKey(owner, {
      chainId: p.chainId,
      nonce: p.nonce,
      accountID: key.accountId,
      name: key.name,
      publicKey: key.address,
      expiresAt: key.expiresAt,
      permissions: key.permissions,
      walletSignature: signature,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    vault.setStatus(id, "failed", message);
    if (/maximum number of API keys/i.test(message)) {
      const oldKeys = await sodextraKeysOn(client, owner, key.accountId, key.name);
      return { ok: false, code: "max-keys", message: MAX_KEYS_MESSAGE, oldKeys };
    }
    return { ok: false, message: `SoDEX refused the key: ${message}` };
  }

  // Both engines must list it before we trade with it (their index can lag).
  for (let i = 0; i < 15; i++) {
    const listed = await client.user
      .apiKeys(owner, { accountID: key.accountId, name: key.name })
      .catch(() => undefined);
    const match = (list: { publicKey: string }[] | undefined) =>
      list?.some((k) => k.publicKey.toLowerCase() === key.address.toLowerCase());
    if (listed && match(listed.spot) && match(listed.perps)) {
      vault.setStatus(id, "active");
      return { ok: true, message: "Key registered on SoDEX.", key: publicKey(vault.get(id)!) };
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  // It may well exist on SoDEX: kept, and turned on once SoDEX lists it (checkActiveKey).
  vault.setStatus(id, "failed", NOT_LISTED_YET);
  return {
    ok: false,
    message:
      "SoDEX accepted the key but hasn't listed it yet. Refresh this page in a minute: it turns on by itself once SoDEX lists it.",
  };
}

/** Sodextra's own earlier keys on this SoDEX account (by name), besides `except`. */
export async function sodextraKeysOn(
  client: Pick<SodexClient, "user">,
  owner: Address,
  accountID: number,
  except: string,
): Promise<string[]> {
  const listed = await client.user.apiKeys(owner, { accountID }).catch(() => undefined);
  if (!listed) return [];
  const names = [...listed.perps, ...listed.spot].map((k) => k.name);
  return [...new Set(names)].filter((n) => n.startsWith("sodextra-") && n !== except).sort();
}

/** When each active key was last found on SoDEX: Setup reloads often, SoDEX's list costs 5. */
const confirmedAt = new Map<string, number>();
const RECHECK_MS = 60_000;
const DELETED_ON_SODEX = "Deleted on SoDEX";
const KEY_GONE_MESSAGE =
  "This key no longer exists on SoDEX (it was deleted there). Create a new one below.";

/**
 * The owner's active key, unless it was deleted on SoDEX (sodex.com's API page): then it's
 * marked failed, so Setup offers a new one and bots stop using it. SoDEX unreachable: the
 * vault is trusted until the next check. With no active key, a key registration gave up
 * on (accepted, not listed yet) turns active once SoDEX lists it.
 */
export async function checkActiveKey(
  vault: Pick<KeyVault, "activeFor" | "setStatus" | "list">,
  client: Pick<SodexClient, "user">,
  owner: Address,
): Promise<void> {
  const key = vault.activeFor(owner);
  if (!key) return reviveUnlisted(vault, client, owner);
  if (Date.now() - (confirmedAt.get(key.id) ?? 0) < RECHECK_MS) return;
  const listed = await client.user
    .apiKeys(owner, { accountID: key.accountId, name: key.name })
    .catch(() => undefined);
  if (!listed) return;
  const match = (list: { publicKey: string }[] | undefined) =>
    list?.some((k) => k.publicKey.toLowerCase() === key.address.toLowerCase()) ?? false;
  if (match(listed.perps) || match(listed.spot)) confirmedAt.set(key.id, Date.now());
  else vault.setStatus(key.id, "failed", DELETED_ON_SODEX);
}

/** The newest key SoDEX accepted but hadn't listed: active once both engines list it. */
async function reviveUnlisted(
  vault: Pick<KeyVault, "setStatus" | "list">,
  client: Pick<SodexClient, "user">,
  owner: Address,
): Promise<void> {
  const key = vault
    .list(owner)
    .find((k) => k.status === "failed" && k.note === NOT_LISTED_YET && k.expiresAt > Date.now());
  if (!key || Date.now() - (confirmedAt.get(key.id) ?? 0) < RECHECK_MS / 4) return;
  confirmedAt.set(key.id, Date.now());
  const listed = await client.user
    .apiKeys(owner, { accountID: key.accountId, name: key.name })
    .catch(() => undefined);
  const match = (list: { publicKey: string }[] | undefined) =>
    list?.some((k) => k.publicKey.toLowerCase() === key.address.toLowerCase()) ?? false;
  if (listed && match(listed.perps) && match(listed.spot)) vault.setStatus(key.id, "active");
}

/** Step 3: prove the key can trade and cancel, with an order that can't fill. */
export async function testKey(
  vault: KeyVault,
  network: Network,
  owner: Address,
  id: string,
): Promise<KeyResult> {
  const key = vault.get(id);
  if (!key || key.status !== "active" || getAddress(key.owner) !== getAddress(owner)) {
    return { ok: false, message: "No such active key." };
  }
  const signer = new ActionSigner({ privateKey: vault.privateKey(id), apiKeyName: key.name });
  const client = new SodexClient({ network, signer });
  const market = await loadMarket(client, "perps", "BTC-USD");
  // 3% below the mark, post-only: it rests and can't fill before we cancel it.
  const price = roundPrice(market.symbol, toDecimal(market.markPrice).mul(0.97), "down");
  const quantity = minQuantityForNotional(market.symbol, price);
  const clOrdID = `sxk-${key.id.slice(0, 8)}-${Date.now().toString(36)}`;

  const [placed] = await client.perps
    .placeOrders({
      accountID: key.accountId,
      symbolID: market.symbol.id,
      orders: [
        {
          clOrdID,
          side: OrderSide.BUY,
          type: OrderType.LIMIT,
          timeInForce: TimeInForce.GTX,
          price,
          quantity,
        },
      ],
    })
    .catch((error: unknown) => {
      // Deleted on sodex.com: retire it here too, so Setup offers a new one.
      if (/API key not found/i.test(error instanceof Error ? error.message : String(error))) {
        vault.setStatus(id, "failed", DELETED_ON_SODEX);
        return [{ code: -1, error: KEY_GONE_MESSAGE }];
      }
      throw error;
    });
  if (placed?.error === KEY_GONE_MESSAGE) return { ok: false, message: KEY_GONE_MESSAGE };
  if (!placed || placed.code !== 0) {
    return { ok: false, message: `Placing the test order failed: ${placed?.error ?? "no result"}` };
  }
  const [cancelled] = await client.perps.cancelOrders({
    accountID: key.accountId,
    cancels: [{ symbolID: market.symbol.id, clOrdID }],
  });
  if (!cancelled || cancelled.code !== 0) {
    return {
      ok: false,
      message: `The key placed an order but couldn't cancel it (${cancelled?.error ?? "no result"}). Cancel ${clOrdID} on sodex.com.`,
    };
  }
  return {
    ok: true,
    message: `The key placed and cancelled a test order (BUY ${quantity} BTC at $${price}, far below the market).`,
    key: publicKey(key),
  };
}

function typedDataFor(key: VaultKey, nonce: bigint, chainId: number) {
  return addPermissionedApiKeyTypedData({
    chainId,
    nonce,
    accountID: key.accountId,
    name: key.name,
    publicKey: key.address,
    expiresAt: key.expiresAt,
    permissions: key.permissions,
  });
}
