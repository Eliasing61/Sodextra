import { hashTypedData, type TypedDataDefinition } from "viem";
import { privateKeyToAddress } from "viem/accounts";

import type { Engine } from "../config.ts";
import { SignatureType } from "../enums.ts";
import type { Address, Hex } from "../types/common.ts";
import type { SignableAction } from "./actions.ts";
import { actionPayloadHash, exchangeActionDigest, signDigest } from "./eip712.ts";

export interface SignerOptions {
  privateKey: Hex;
  /**
   * Name of the registered API key this private key belongs to (sent as X-API-Key).
   * Omit only when signing directly with the master wallet.
   */
  apiKeyName?: string;
}

/**
 * Holds one signing key in memory. Never log or serialise it.
 * Nonces are tracked per signing address, so give each trading process its own key.
 */
export class ActionSigner {
  readonly address: Address;
  readonly apiKeyName: string | undefined;
  readonly #privateKey: Hex;

  constructor(options: SignerOptions) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(options.privateKey)) {
      throw new Error("Private key must be 0x followed by 64 hex characters");
    }
    if (options.apiKeyName !== undefined && !/^[0-9a-zA-Z_-]{1,36}$/.test(options.apiKeyName)) {
      throw new Error("API key name must match ^[0-9a-zA-Z_-]{1,36}$");
    }
    this.#privateKey = options.privateKey;
    this.apiKeyName = options.apiKeyName;
    this.address = privateKeyToAddress(options.privateKey);
  }

  /** Trading action → X-API-Sign value (0x01-prefixed). */
  async signAction(
    engine: Engine,
    chainId: number,
    action: SignableAction,
    nonce: bigint,
  ): Promise<Hex> {
    const digest = exchangeActionDigest(engine, chainId, actionPayloadHash(action), nonce);
    return signDigest(digest, this.#privateKey, SignatureType.EIP712);
  }

  /** Account-level universal action (master wallet only) → X-API-Sign value (0x02-prefixed). */
  async signUniversal(typedData: TypedDataDefinition): Promise<Hex> {
    return signDigest(hashTypedData(typedData), this.#privateKey, SignatureType.EIP712_UNIVERSAL);
  }

  toJSON(): { address: Address; apiKeyName: string | undefined } {
    return { address: this.address, apiKeyName: this.apiKeyName };
  }
}
