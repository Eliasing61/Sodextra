/**
 * Sodextra's SoDEX builder fee (docs: Builder Codes in Trading). Bot orders carry
 * builder 1061 at 0.2 bp (0.1 bp until 2026-11-06); SoDEX only charges it once the user has
 * approved that maximum with their wallet, which Setup asks for (one signature, no money
 * moves). Starting a bot requires the approval; the builder's own wallet is exempt. Users who
 * approved the old 0.1 bp are asked again when they start a bot; bots restarting by themselves
 * (after a server restart) keep the rate their user approved.
 */
import { builder, builderFor } from "@sodextra/cli/env";
import { approveBuilderFeeTypedData, type SodexClient } from "@sodextra/sodex-client";
import { getAddress, verifyTypedData, type Address, type Hex } from "viem";

const STATUS_TTL_MS = 60_000;
const PENDING_TTL_MS = 10 * 60_000;

export interface BuilderStatus {
  /** This wallet's bots carry the builder code (false for the builder itself, or when off). */
  required: boolean;
  approved: boolean;
  builderID: number;
  /** Tenths of a bp (2 = 0.2 bp): the fee now. */
  fee: number;
  /** What this wallet has approved for Sodextra (tenths of a bp; 0 = nothing). */
  approvedFee: number;
}

const cache = new Map<string, { status: BuilderStatus; at: number }>();
const pending = new Map<
  string,
  { nonce: bigint; chainId: number; accountID: number; until: number }
>();

export async function builderStatus(
  client: SodexClient,
  owner: Address,
  fresh = false,
): Promise<BuilderStatus> {
  const key = owner.toLowerCase();
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.status;
  const code = builderFor(key);
  let approvedFee = 0;
  if (code) {
    const list = await client.user.builders(owner);
    approvedFee = Math.max(
      0,
      ...list.perps.filter((b) => Number(b.builderID) === code.id).map((b) => Number(b.feeRate)),
    );
  }
  const status = {
    required: code !== undefined,
    approved: code !== undefined && approvedFee >= code.fee,
    builderID: builder.id,
    fee: builder.fee,
    approvedFee,
  };
  cache.set(key, { status, at: Date.now() });
  return status;
}

/** The message the wallet signs to approve the builder fee (uint64 fields as strings for JSON). */
export async function prepareApproval(client: SodexClient, owner: Address) {
  const code = builderFor(owner.toLowerCase());
  if (!code) throw new Error("This wallet doesn't need to approve a builder fee.");
  const state = await client.perps.state(owner);
  if (!state.aid)
    throw new Error("This wallet has no SoDEX account yet. Deposit on sodex.com first.");
  const nonce = BigInt(Date.now());
  const chainId = client.network.chainId;
  pending.set(owner.toLowerCase(), {
    nonce,
    chainId,
    accountID: Number(state.aid),
    until: Date.now() + PENDING_TTL_MS,
  });
  const typed = approveBuilderFeeTypedData({
    chainId,
    nonce,
    accountID: state.aid,
    builderID: code.id,
    maxFeeRate: code.fee,
  });
  return {
    builderID: code.id,
    fee: code.fee,
    typedData: JSON.parse(
      JSON.stringify(typed, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)),
    ) as unknown,
  };
}

/** Check the wallet's signature and submit the approval to SoDEX. */
export async function submitApproval(
  client: SodexClient,
  owner: Address,
  signature: Hex,
): Promise<{ ok: boolean; message: string }> {
  const code = builderFor(owner.toLowerCase());
  const p = pending.get(owner.toLowerCase());
  if (!code || !p || p.until < Date.now())
    return { ok: false, message: "This approval request expired. Start again." };
  const typed = approveBuilderFeeTypedData({
    chainId: p.chainId,
    nonce: p.nonce,
    accountID: p.accountID,
    builderID: code.id,
    maxFeeRate: code.fee,
  });
  const valid = await verifyTypedData({ address: getAddress(owner), ...typed, signature }).catch(
    () => false,
  );
  if (!valid) return { ok: false, message: "The signature isn't from your wallet." };
  pending.delete(owner.toLowerCase());
  try {
    await client.user.approveBuilderFee(owner, {
      chainId: p.chainId,
      nonce: p.nonce,
      accountID: p.accountID,
      builderID: code.id,
      maxFeeRate: code.fee,
      walletSignature: signature,
    });
  } catch (error) {
    return {
      ok: false,
      message: `SoDEX refused the approval: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // SoDEX's list can lag the approval by a moment.
  for (let i = 0; i < 10; i++) {
    if ((await builderStatus(client, owner, true).catch(() => undefined))?.approved)
      return { ok: true, message: "Approved. Your bots can start." };
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return { ok: false, message: "SoDEX accepted it but hasn't listed it yet. Refresh in a minute." };
}

const bp = (tenths: number) => `${tenths / 10} bp`;

/** Why a start waits for the fee approval: a first approval, or the raised fee (2026-11-06). */
export function approvalNeeded(status: BuilderStatus): string {
  return status.approvedFee > 0
    ? `Sodextra's fee is now ${bp(status.fee)} (you approved ${bp(status.approvedFee)}). Approve the new fee to start or restart bots: one wallet signature, no money moves.`
    : `Approve Sodextra's ${bp(status.fee)} fee in Setup first (one wallet signature; no money moves).`;
}

/**
 * The fee a bot launched now carries (tenths of a bp). A start someone asked for has the
 * current approval (the start checks it): the current fee. A bot restarting by itself after a
 * server restart never asks more than its user approved, nor, when SoDEX couldn't be asked,
 * more than the old 0.1 bp every earlier user approved.
 */
export function launchFee(status: BuilderStatus | undefined, byItself: boolean): number {
  if (!byItself) return builder.fee;
  if (!status) return Math.min(builder.fee, 1);
  return Math.min(builder.fee, status.approvedFee);
}
