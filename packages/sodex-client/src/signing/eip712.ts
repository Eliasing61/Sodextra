import { concatHex, hashTypedData, keccak256, numberToHex, stringToBytes, zeroAddress } from "viem";
import { sign } from "viem/accounts";

import type { Engine } from "../config.ts";
import { APIKeyType, SignatureType } from "../enums.ts";
import type { Address, Hex, Uint64 } from "../types/common.ts";
import { canonicalJson } from "./canonical-json.ts";
import type { SignableAction } from "./actions.ts";

export const ENGINE_DOMAIN_NAME: Record<Engine, string> = { spot: "spot", perps: "futures" };

export function engineDomain(engine: Engine, chainId: number) {
  return {
    name: ENGINE_DOMAIN_NAME[engine],
    version: "1",
    chainId,
    verifyingContract: zeroAddress,
  } as const;
}

export function universalDomain(chainId: number) {
  return { name: "universal", version: "1", chainId, verifyingContract: zeroAddress } as const;
}

export const EXCHANGE_ACTION_TYPES = {
  ExchangeAction: [
    { name: "payloadHash", type: "bytes32" },
    { name: "nonce", type: "uint64" },
  ],
} as const;

/** keccak256 of the compact `{type, params}` JSON. */
export function actionPayloadHash(action: SignableAction): Hex {
  return keccak256(stringToBytes(canonicalJson({ type: action.type, params: action.params })));
}

/** The EIP-712 digest a trading-action signature is made over. */
export function exchangeActionDigest(
  engine: Engine,
  chainId: number,
  payloadHash: Hex,
  nonce: bigint,
): Hex {
  return hashTypedData({
    domain: engineDomain(engine, chainId),
    types: EXCHANGE_ACTION_TYPES,
    primaryType: "ExchangeAction",
    message: { payloadHash, nonce },
  });
}

/** `type byte || r || s || v` with v normalised to 0/1, as the gateway expects in X-API-Sign. */
export function encodeSignature(
  type: SignatureType,
  sig: { r: Hex; s: Hex; yParity: number },
): Hex {
  return concatHex([
    numberToHex(type, { size: 1 }),
    sig.r,
    sig.s,
    numberToHex(sig.yParity, { size: 1 }),
  ]);
}

export async function signDigest(digest: Hex, privateKey: Hex, type: SignatureType): Promise<Hex> {
  const sig = await sign({ hash: digest, privateKey, to: "object" });
  return encodeSignature(type, { r: sig.r, s: sig.s, yParity: sig.yParity ?? 0 });
}

/** A wallet's 65-byte r||s||v signature (v = 27/28 or 0/1) → SoDEX wire format: type byte + r + s + v(0/1). */
export function walletToWireSignature(signature: Hex, type: SignatureType): Hex {
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("Wallet signature must be 65 bytes");
  const v = parseInt(signature.slice(130, 132), 16);
  const recovery = v >= 27 ? v - 27 : v;
  if (recovery !== 0 && recovery !== 1) throw new Error("Unexpected signature recovery byte");
  return `${numberToHex(type, { size: 1 })}${signature.slice(2, 130)}${recovery.toString(16).padStart(2, "0")}` as Hex;
}

/** Strip the 1-byte type prefix and return a 65-byte r||s||v signature (v = 27/28) for recovery. */
export function toRecoverableSignature(wireSignature: Hex): Hex {
  if (wireSignature.length !== 2 + 66 * 2) throw new Error("Wire signature must be 66 bytes");
  const body = wireSignature.slice(4);
  const v = parseInt(body.slice(128, 130), 16);
  return `0x${body.slice(0, 128)}${(v < 27 ? v + 27 : v).toString(16).padStart(2, "0")}`;
}

// ── Account-level actions (universal domain, master wallet signs) ─────────────
// These return typed data that a browser wallet can sign directly
// (wagmi/viem signTypedData). The wire signature uses prefix 0x02.

export interface AddApiKeyFields {
  chainId: number;
  nonce: bigint;
  accountID: Uint64;
  name: string;
  /** The API key's EVM address. */
  publicKey: Address;
  /** Ms timestamp; 0 = no expiry. */
  expiresAt: Uint64;
}

export function addApiKeyTypedData(f: AddApiKeyFields) {
  return {
    domain: universalDomain(f.chainId),
    types: {
      AddAPIKey: [
        { name: "accountID", type: "uint64" },
        { name: "name", type: "string" },
        { name: "keyType", type: "uint8" },
        { name: "publicKey", type: "bytes" },
        { name: "expiresAt", type: "uint64" },
        { name: "nonce", type: "uint64" },
      ],
    },
    primaryType: "AddAPIKey",
    message: {
      accountID: BigInt(f.accountID),
      name: f.name,
      keyType: APIKeyType.EVM,
      publicKey: f.publicKey,
      expiresAt: BigInt(f.expiresAt),
      nonce: f.nonce,
    },
  } as const;
}

export function addPermissionedApiKeyTypedData(f: AddApiKeyFields & { permissions: number }) {
  return {
    domain: universalDomain(f.chainId),
    types: {
      UserSignedAddPermissionedAPIKeyAction: [
        { name: "chainID", type: "uint64" },
        { name: "nonce", type: "uint64" },
        { name: "accountID", type: "uint64" },
        { name: "name", type: "string" },
        { name: "keyType", type: "uint8" },
        { name: "publicKey", type: "bytes" },
        { name: "expiresAt", type: "uint64" },
        { name: "permissions", type: "uint64" },
      ],
    },
    primaryType: "UserSignedAddPermissionedAPIKeyAction",
    message: {
      chainID: BigInt(f.chainId),
      nonce: f.nonce,
      accountID: BigInt(f.accountID),
      name: f.name,
      keyType: APIKeyType.EVM,
      publicKey: f.publicKey,
      expiresAt: BigInt(f.expiresAt),
      permissions: BigInt(f.permissions),
    },
  } as const;
}

export interface ApproveBuilderFeeFields {
  chainId: number;
  nonce: bigint;
  /** The user's primary account ID. */
  accountID: Uint64;
  /** The builder's account ID. */
  builderID: Uint64;
  /** Most the builder may charge, in tenths of a basis point (0 clears the approval). */
  maxFeeRate: number;
}

/** Approve (or clear) a builder's maximum fee: `ApproveBuilderFeeAction`, universal domain. */
export function approveBuilderFeeTypedData(f: ApproveBuilderFeeFields) {
  return {
    domain: universalDomain(f.chainId),
    types: {
      ApproveBuilderFeeAction: [
        { name: "chainID", type: "uint64" },
        { name: "nonce", type: "uint64" },
        { name: "accountID", type: "uint64" },
        { name: "builderID", type: "uint64" },
        { name: "maxFeeRate", type: "uint64" },
      ],
    },
    primaryType: "ApproveBuilderFeeAction",
    message: {
      chainID: BigInt(f.chainId),
      nonce: f.nonce,
      accountID: BigInt(f.accountID),
      builderID: BigInt(f.builderID),
      maxFeeRate: BigInt(f.maxFeeRate),
    },
  } as const;
}
