import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ActionSigner, type Address, type Hex, type Network } from "@sodextra/sodex-client";

import { KeyVault } from "./vault.ts";

/** Repo root (…/sodextra), independent of the working directory. */
export const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const DATA_DIR = join(ROOT, ".sodextra");
export const DB_PATH = join(DATA_DIR, "sodextra.db");
export const CACHE_DIR = join(DATA_DIR, "cache");
export const LOCK_DIR = join(DATA_DIR, "locks");
/** Encrypted bot keys (see vault.ts). */
export const VAULT_PATH = join(DATA_DIR, "vault.db");

const envFile = join(ROOT, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
mkdirSync(DATA_DIR, { recursive: true });

const optional = (name: string) => process.env[name]?.trim() || undefined;

export const env = {
  network: (optional("SODEX_NETWORK") ?? "mainnet") as Network,
  userAddress: optional("SODEX_USER_ADDRESS") as Address | undefined,
  accountId: optional("SODEX_ACCOUNT_ID"),
  apiKeyName: optional("SODEX_API_KEY_NAME"),
  apiKeyPrivateKey: optional("SODEX_API_KEY_PRIVATE_KEY") as Hex | undefined,
};

/** The server's own account (.env), which bots without an owner trade. Lowercase. */
export const serverAccount = /^0x[0-9a-fA-F]{40}$/.test(env.userAddress ?? "")
  ? env.userAddress!.toLowerCase()
  : undefined;

/** The account a bot trades: its owner's, or the server's. */
export function accountOf(bot: { owner?: string | undefined }): string | undefined {
  return bot.owner?.toLowerCase() ?? serverAccount;
}

/**
 * Switch this process to a bot owner's account (each bot runs in its own process).
 * Another wallet's bot signs only with that wallet's vault key: the .env key, account
 * ID and address belong to the server's account and are dropped.
 */
export function useAccountOf(file: { owner?: string | undefined }): void {
  const owner = file.owner?.toLowerCase();
  if (!owner || owner === serverAccount) return;
  env.userAddress = owner as Address;
  env.accountId = undefined;
  env.apiKeyName = undefined;
  env.apiKeyPrivateKey = undefined;
}

if (env.network !== "mainnet" && env.network !== "testnet") {
  throw new Error(`SODEX_NETWORK must be mainnet or testnet (got ${env.network})`);
}

export function requireUser(): Address {
  if (!env.userAddress || !/^0x[0-9a-fA-F]{40}$/.test(env.userAddress)) {
    throw new Error("Set SODEX_USER_ADDRESS (your main wallet address) in .env");
  }
  return env.userAddress;
}

/** Where the trading key comes from: the encrypted vault (preferred) or .env. */
export let signerSource: "vault" | "env" | undefined;

export function requireSigner(): ActionSigner {
  const fromVault = vaultSigner();
  if (fromVault) {
    signerSource = "vault";
    return fromVault;
  }
  signerSource = "env";
  if (!env.apiKeyName || !env.apiKeyPrivateKey) {
    if (env.userAddress?.toLowerCase() !== serverAccount) {
      throw new Error("This wallet has no active bot key yet. Create one in Setup on the website.");
    }
    throw new Error("Set SODEX_API_KEY_NAME and SODEX_API_KEY_PRIVATE_KEY in .env");
  }
  return new ActionSigner({ privateKey: env.apiKeyPrivateKey, apiKeyName: env.apiKeyName });
}

/** The owner's newest active vault key, when the vault is set up (SODEXTRA_VAULT_KEY). */
function vaultSigner(): ActionSigner | undefined {
  const master = KeyVault.masterKeyFromEnv(optional("SODEXTRA_VAULT_KEY"));
  if (!master || !env.userAddress) return undefined;
  const vault = new KeyVault({ dbPath: VAULT_PATH, masterKey: master });
  try {
    const key = vault.activeFor(env.userAddress);
    return key
      ? new ActionSigner({ privateKey: vault.privateKey(key.id), apiKeyName: key.name })
      : undefined;
  } finally {
    vault.close();
  }
}

/**
 * Sodextra's SoDEX builder code, added to bot orders: builder account 1061 at a fee of
 * 2 (tenths of a bp, so 0.2 bp; SoDEX takes whole tenths only), paid by the user on top of
 * SoDEX's fee once they've approved it in Setup. The API sets each
 * bot's fee when it launches it (SODEXTRA_BUILDER_FEE): a bot restarting by itself never asks
 * more than its user approved. The builder's own wallet (SODEXTRA_BUILDER_OWNER) never
 * pays itself.
 * SODEXTRA_BUILDER_ID=0 turns it off.
 */
export const builder = {
  id: Number(process.env.SODEXTRA_BUILDER_ID ?? 1061),
  fee: Number(process.env.SODEXTRA_BUILDER_FEE ?? 2),
  owner: (process.env.SODEXTRA_BUILDER_OWNER ?? "").toLowerCase(),
};

/** The builder code for a bot trading this account (none for the builder itself, or when off). */
export function builderFor(account: string | undefined): { id: number; fee: number } | undefined {
  if (!(builder.id > 0) || !(builder.fee > 0)) return undefined;
  if (account === undefined || account.toLowerCase() === builder.owner) return undefined;
  return { id: builder.id, fee: builder.fee };
}
