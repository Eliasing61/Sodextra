/**
 * Hands out nonces per signing address: the current ms timestamp, or last + 1
 * when several requests are signed within the same millisecond. The gateway
 * keeps the 100 highest nonces per signer and accepts nonces within
 * (blockTime − 2 days, blockTime + 1 day), so a clock-based counter is safe as
 * long as the machine's clock is synced.
 *
 * In-memory: one process per signing key. The server version will back this with Redis.
 */
export class NonceManager {
  readonly #last = new Map<string, bigint>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  next(signerAddress: string): bigint {
    const key = signerAddress.toLowerCase();
    const now = BigInt(this.#now());
    const last = this.#last.get(key) ?? 0n;
    const nonce = now > last ? now : last + 1n;
    this.#last.set(key, nonce);
    return nonce;
  }
}
