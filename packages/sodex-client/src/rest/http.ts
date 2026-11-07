import { SodexApiError, SodexHttpError, SodexNetworkError } from "../errors.ts";
import { parseJson } from "../json.ts";
import type { WeightLimiter } from "../rate-limit.ts";
import type { Hex } from "../types/common.ts";

export type QueryValue = string | number | bigint | boolean | undefined;
export type Query = Record<string, QueryValue>;

export interface SignedHeaders {
  sign: Hex;
  nonce: bigint;
  chainId: number;
  /** Omit for direct master-wallet signing. */
  apiKeyName?: string | undefined;
}

export interface HttpRequest {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Query;
  /** Already-serialised canonical JSON (must be byte-identical to what was signed). */
  body?: string;
  signed?: SignedHeaders;
  /** Request weight for the per-IP budget. */
  weight: number;
}

export interface HttpTransportOptions {
  baseUrl: string;
  limiter: WeightLimiter;
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Waits before each retry of a read that hit a network error (default 300 ms, then 1 s). */
  retryDelaysMs?: number[];
}

/**
 * A read (GET) that fails on the network is tried again: a dropped connection made a bot's
 * first request at start fail now and then, and the start with it. Writes are never
 * retried here: their outcome is unknown, and the engine reconciles before trying again.
 * A timeout is retried once (each already waited the full timeout).
 */
const READ_RETRY_DELAYS_MS = [300, 1_000];

/** Thin fetch wrapper: weight budget, timeouts, uint64-safe parsing, SoDEX envelope handling. */
export class HttpTransport {
  readonly #baseUrl: string;
  readonly #limiter: WeightLimiter;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #retryDelaysMs: number[];

  constructor(options: HttpTransportOptions) {
    this.#baseUrl = options.baseUrl.replace(/\/$/, "");
    this.#limiter = options.limiter;
    this.#timeoutMs = options.timeoutMs ?? 15_000;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#retryDelaysMs = options.retryDelaysMs ?? READ_RETRY_DELAYS_MS;
  }

  async request<T>(req: HttpRequest): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.#once<T>(req);
      } catch (error) {
        const timedOut =
          error instanceof SodexNetworkError &&
          (error.cause as { name?: string } | undefined)?.name === "TimeoutError";
        const retries = timedOut
          ? Math.min(1, this.#retryDelaysMs.length)
          : this.#retryDelaysMs.length;
        if (!(error instanceof SodexNetworkError) || req.method !== "GET" || attempt >= retries)
          throw error;
        await new Promise((r) => setTimeout(r, this.#retryDelaysMs[attempt]));
      }
    }
  }

  async #once<T>(req: HttpRequest): Promise<T> {
    await this.#limiter.acquire(req.weight);

    const url = new URL(this.#baseUrl + req.path);
    for (const [key, value] of Object.entries(req.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const headers: Record<string, string> = { Accept: "application/json" };
    if (req.body !== undefined) headers["Content-Type"] = "application/json";
    if (req.signed) {
      headers["X-API-Sign"] = req.signed.sign;
      headers["X-API-Nonce"] = req.signed.nonce.toString();
      headers["X-API-Chain"] = String(req.signed.chainId);
      if (req.signed.apiKeyName !== undefined) headers["X-API-Key"] = req.signed.apiKeyName;
    }

    const isWrite = req.method !== "GET";
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(url, {
        method: req.method,
        headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
      text = await response.text();
    } catch (cause) {
      throw new SodexNetworkError(req.path, isWrite, { cause });
    }

    this.#limiter.syncFromHeaders(response.headers);

    let envelope: { code?: unknown; error?: unknown; data?: unknown } | undefined;
    try {
      const parsed = parseJson(text);
      if (parsed !== null && typeof parsed === "object" && "code" in parsed) {
        envelope = parsed as typeof envelope;
      }
    } catch {
      envelope = undefined;
    }

    if (envelope) {
      const code = Number(envelope.code);
      if (code !== 0) {
        throw new SodexApiError(
          code,
          String(envelope.error ?? "unknown error"),
          response.status,
          req.path,
        );
      }
      if (!response.ok) throw new SodexHttpError(response.status, text, req.path);
      return envelope.data as T;
    }
    throw new SodexHttpError(response.status, text, req.path);
  }
}
