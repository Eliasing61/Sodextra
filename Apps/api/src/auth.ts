/**
 * Wallet sign-in (EIP-4361 "Sign-In with Ethereum") for the dashboard API.
 * See docs/security.md. Sessions are random tokens in an HttpOnly, Secure,
 * SameSite=Strict cookie; only their SHA-256 hashes are stored.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { getAddress, isAddress, verifyMessage, type Address, type Hex } from "viem";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";

export const COOKIE = "sx_session";
const NONCE_TTL_MS = 5 * 60_000;
const MAX_MESSAGE_AGE_MS = 10 * 60_000;
const MAX_NONCES = 1_000;
const ATTEMPT_WINDOW_MS = 5 * 60_000;
const MAX_ATTEMPTS = 10;

export interface AuthOptions {
  /** SQLite file for sessions (":memory:" in tests). */
  dbPath: string;
  /** Addresses allowed to sign in, or ["*"] for any wallet. Must not be empty. */
  allowed: string[];
  /** Origins the sign-in message may name, e.g. "https://sodextra.xyz". */
  origins: string[];
  sessionTtlMs?: number;
  /** Mark the cookie Secure (browsers accept Secure cookies on http://localhost). */
  secureCookie?: boolean;
  now?: () => number;
}

export type SignInResult =
  { ok: true; address: Address; token: string; expiresAt: number } | { ok: false; reason: string };

export class Auth {
  readonly #db: DatabaseSync;
  readonly #allowed: Set<string>;
  /** Any wallet may sign in (SODEXTRA_ALLOWED_ADDRESSES=*). */
  readonly #open: boolean;
  readonly #origins: Set<string>;
  readonly #hosts: Set<string>;
  readonly #ttl: number;
  readonly #secure: boolean;
  readonly #now: () => number;
  readonly #nonces = new Map<string, number>();
  readonly #attempts = new Map<string, number[]>();

  constructor(options: AuthOptions) {
    this.#open = options.allowed.some((a) => a.trim() === "*");
    const allowed = options.allowed.filter((a) => isAddress(a)).map((a) => getAddress(a));
    if (allowed.length === 0 && !this.#open) {
      throw new Error(
        "No allowed sign-in address. Set SODEXTRA_ALLOWED_ADDRESSES (wallets, or * for anyone) in .env.",
      );
    }
    this.#allowed = new Set(allowed);
    this.#origins = new Set(options.origins);
    this.#hosts = new Set(options.origins.map((o) => new URL(o).host));
    this.#ttl = options.sessionTtlMs ?? 7 * 24 * 3600_000;
    this.#secure = options.secureCookie ?? true;
    this.#now = options.now ?? Date.now;
    if (options.dbPath !== ":memory:") mkdirSync(dirname(options.dbPath), { recursive: true });
    this.#db = new DatabaseSync(options.dbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        address TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
    `);
    this.prune();
  }

  /** Any wallet may sign in (SODEXTRA_ALLOWED_ADDRESSES=*). */
  get open(): boolean {
    return this.#open;
  }

  get allowed(): Address[] {
    return [...this.#allowed] as Address[];
  }

  close(): void {
    this.#db.close();
  }

  /** A fresh single-use nonce for one sign-in message. */
  issueNonce(): string {
    this.#sweepNonces();
    if (this.#nonces.size >= MAX_NONCES) throw new Error("too many pending sign-ins");
    const nonce = generateSiweNonce();
    this.#nonces.set(nonce, this.#now() + NONCE_TTL_MS);
    return nonce;
  }

  async signIn(message: string, signature: string, client: string): Promise<SignInResult> {
    if (!this.#allow(client))
      return { ok: false, reason: "Too many sign-in attempts. Wait a few minutes." };
    if (
      typeof message !== "string" ||
      message.length > 2_000 ||
      !/^0x[0-9a-fA-F]{130}$/.test(signature)
    ) {
      return { ok: false, reason: "Malformed sign-in request." };
    }
    const now = this.#now();
    const parsed = parseSiweMessage(message);
    if (!parsed.address || !parsed.nonce || !parsed.domain || !parsed.uri || !parsed.issuedAt) {
      return { ok: false, reason: "Incomplete sign-in message." };
    }

    // Single use: the nonce is spent whatever happens next.
    const nonceExpiry = this.#nonces.get(parsed.nonce);
    this.#nonces.delete(parsed.nonce);
    if (nonceExpiry === undefined || nonceExpiry < now) {
      return { ok: false, reason: "This sign-in request expired. Try again." };
    }
    if (!this.#hosts.has(parsed.domain) || !this.#origins.has(new URL(parsed.uri).origin)) {
      return { ok: false, reason: "The sign-in message is for a different site." };
    }
    const issued = parsed.issuedAt.getTime();
    if (issued > now + 60_000 || now - issued > MAX_MESSAGE_AGE_MS) {
      return { ok: false, reason: "The sign-in message is too old." };
    }
    if (!parsed.expirationTime || parsed.expirationTime.getTime() - issued > MAX_MESSAGE_AGE_MS) {
      return { ok: false, reason: "The sign-in message needs a short expiry." };
    }
    if (
      !validateSiweMessage({
        message: parsed,
        domain: parsed.domain,
        nonce: parsed.nonce,
        time: new Date(now),
      })
    ) {
      return { ok: false, reason: "The sign-in message isn't valid." };
    }

    const address = getAddress(parsed.address);
    const valid = await verifyMessage({ address, message, signature: signature as Hex }).catch(
      () => false,
    );
    if (!valid) return { ok: false, reason: "The signature doesn't match the address." };
    if (!this.#isAllowed(address)) {
      return { ok: false, reason: "This wallet isn't allowed to use this Sodextra server." };
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = now + this.#ttl;
    this.#db
      .prepare(
        "INSERT INTO sessions (token_hash, address, created_at, expires_at) VALUES (?, ?, ?, ?)",
      )
      .run(hash(token), address, now, expiresAt);
    return { ok: true, address, token, expiresAt };
  }

  /** The signed-in address for a request's Cookie header, if its session is valid. */
  session(cookieHeader: string | undefined): Address | undefined {
    const token = readCookie(cookieHeader, COOKIE);
    if (!token) return undefined;
    const row = this.#db
      .prepare("SELECT address, expires_at FROM sessions WHERE token_hash = ?")
      .get(hash(token));
    if (!row || Number(row.expires_at) < this.#now()) return undefined;
    const address = String(row.address);
    // An address removed from the allowlist loses access straight away.
    return this.#isAllowed(address) ? (address as Address) : undefined;
  }

  #isAllowed(address: string): boolean {
    return this.#open || this.#allowed.has(address);
  }

  signOut(cookieHeader: string | undefined): void {
    const token = readCookie(cookieHeader, COOKIE);
    if (token) this.#db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
  }

  prune(): void {
    this.#db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(this.#now());
  }

  cookie(token: string, expiresAt: number): string {
    const maxAge = Math.max(0, Math.floor((expiresAt - this.#now()) / 1000));
    return `${COOKIE}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${this.#secure ? "; Secure" : ""}`;
  }

  clearCookie(): string {
    return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict${this.#secure ? "; Secure" : ""}`;
  }

  #allow(client: string): boolean {
    const now = this.#now();
    const recent = (this.#attempts.get(client) ?? []).filter((t) => now - t < ATTEMPT_WINDOW_MS);
    recent.push(now);
    this.#attempts.set(client, recent);
    if (this.#attempts.size > 10_000) this.#attempts.clear();
    return recent.length <= MAX_ATTEMPTS;
  }

  #sweepNonces(): void {
    const now = this.#now();
    for (const [nonce, expiry] of this.#nonces) if (expiry < now) this.#nonces.delete(nonce);
  }
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=") || undefined;
  }
  return undefined;
}
