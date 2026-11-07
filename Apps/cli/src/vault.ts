/**
 * Key vault: bot API keys, encrypted at rest (docs/security.md).
 *
 * - Keys are generated here, on the server, and never leave it.
 * - Each private key is sealed with AES-256-GCM under a master key from the
 *   environment (SODEXTRA_VAULT_KEY), never stored in the database or the repo.
 * - The ciphertext is bound to its row (id + address as associated data), so a
 *   sealed key can't be swapped onto another record.
 */
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

type Hex = `0x${string}`;

export type VaultKeyStatus = "pending" | "active" | "failed";

/**
 * The note on a key SoDEX accepted but hadn't listed when registration gave up waiting:
 * it may exist on SoDEX, so it's kept a day (not pruned) for the next check to pick up.
 */
export const NOT_LISTED_YET = "Accepted by SoDEX, not listed yet";
const NOT_LISTED_KEPT_MS = 24 * 3600_000;

export interface VaultKey {
  id: string;
  /** The SoDEX API key name (X-API-Key). */
  name: string;
  /** The key's public EVM address (registered on SoDEX). */
  address: Hex;
  /** The master wallet that owns the SoDEX account. */
  owner: Hex;
  accountId: number;
  /** SoDEX permission mask: a set bit disables a permission. */
  permissions: number;
  expiresAt: number;
  status: VaultKeyStatus;
  note?: string | undefined;
  createdAt: number;
}

export class KeyVault {
  readonly #db: DatabaseSync;
  readonly #master: Buffer;

  constructor(options: { dbPath: string; masterKey: Buffer }) {
    if (options.masterKey.length !== 32) throw new Error("The vault master key must be 32 bytes");
    this.#master = options.masterKey;
    if (options.dbPath !== ":memory:") mkdirSync(dirname(options.dbPath), { recursive: true });
    this.#db = new DatabaseSync(options.dbPath);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS keys (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        owner TEXT NOT NULL,
        account_id INTEGER NOT NULL,
        permissions INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        note TEXT,
        created_at INTEGER NOT NULL,
        iv BLOB NOT NULL,
        tag BLOB NOT NULL,
        sealed BLOB NOT NULL
      );
    `);
  }

  /** SODEXTRA_VAULT_KEY: 32 random bytes as base64 (npm run vault:key makes one). */
  static masterKeyFromEnv(value: string | undefined): Buffer | undefined {
    if (!value) return undefined;
    const key = Buffer.from(value.trim(), "base64");
    if (key.length !== 32) {
      throw new Error(
        "SODEXTRA_VAULT_KEY must be 32 bytes, base64-encoded (run: npm run vault:key)",
      );
    }
    return key;
  }

  close(): void {
    this.#db.close();
  }

  /** Generate a new key pair and keep it sealed as "pending" until SoDEX accepts it. */
  createPending(input: {
    name: string;
    owner: Hex;
    accountId: number;
    permissions: number;
    expiresAt: number;
    now?: number;
  }): VaultKey {
    const id = randomUUID();
    const privateKey = generatePrivateKey();
    const address = privateKeyToAddress(privateKey);
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#master, iv);
    cipher.setAAD(aad(id, address));
    const sealed = Buffer.concat([cipher.update(privateKey, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const createdAt = input.now ?? Date.now();
    this.#db
      .prepare(
        `INSERT INTO keys (id, name, address, owner, account_id, permissions, expires_at, status, created_at, iv, tag, sealed)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        address,
        input.owner.toLowerCase(),
        input.accountId,
        input.permissions,
        input.expiresAt,
        createdAt,
        iv,
        tag,
        sealed,
      );
    return this.get(id)!;
  }

  get(id: string): VaultKey | undefined {
    const row = this.#db.prepare("SELECT * FROM keys WHERE id = ?").get(id);
    return row ? toKey(row) : undefined;
  }

  /** Newest first, without secrets. */
  list(owner: Hex): VaultKey[] {
    return this.#db
      .prepare("SELECT * FROM keys WHERE owner = ? ORDER BY created_at DESC")
      .all(owner.toLowerCase())
      .map(toKey);
  }

  setStatus(id: string, status: VaultKeyStatus, note?: string): void {
    this.#db
      .prepare("UPDATE keys SET status = ?, note = ? WHERE id = ?")
      .run(status, note ?? null, id);
  }

  /** The newest active, unexpired key for an account owner. */
  activeFor(owner: Hex, now = Date.now()): VaultKey | undefined {
    const row = this.#db
      .prepare(
        "SELECT * FROM keys WHERE owner = ? AND status = 'active' AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
      )
      .get(owner.toLowerCase(), now);
    return row ? toKey(row) : undefined;
  }

  /** Decrypt a key's private key. Only for keys SoDEX has accepted. */
  privateKey(id: string): Hex {
    const row = this.#db.prepare("SELECT * FROM keys WHERE id = ?").get(id);
    if (!row) throw new Error("No such vault key");
    if (String(row.status) !== "active") throw new Error("This key isn't active");
    return this.#open(row);
  }

  /** Decrypt a pending key (used only to test it right after registration). */
  pendingPrivateKey(id: string): Hex {
    const row = this.#db.prepare("SELECT * FROM keys WHERE id = ?").get(id);
    if (!row) throw new Error("No such vault key");
    return this.#open(row);
  }

  /** Forget pending keys that were never registered (keys SoDEX may hold are kept a day). */
  prunePending(olderThanMs: number, now = Date.now()): void {
    this.#db
      .prepare(
        "DELETE FROM keys WHERE status IN ('pending', 'failed') AND created_at < ? AND NOT (note IS ? AND created_at >= ?)",
      )
      .run(now - olderThanMs, NOT_LISTED_YET, now - NOT_LISTED_KEPT_MS);
  }

  #open(row: Record<string, unknown>): Hex {
    const decipher = createDecipheriv("aes-256-gcm", this.#master, row.iv as Uint8Array);
    decipher.setAAD(aad(String(row.id), String(row.address) as Hex));
    decipher.setAuthTag(row.tag as Uint8Array);
    const plain = Buffer.concat([
      decipher.update(row.sealed as Uint8Array),
      decipher.final(),
    ]).toString("utf8");
    return plain as Hex;
  }
}

function aad(id: string, address: Hex): Buffer {
  return Buffer.from(`sodextra-vault:v1:${id}:${address.toLowerCase()}`, "utf8");
}

function toKey(row: Record<string, unknown>): VaultKey {
  return {
    id: String(row.id),
    name: String(row.name),
    address: String(row.address) as Hex,
    owner: String(row.owner) as Hex,
    accountId: Number(row.account_id),
    permissions: Number(row.permissions),
    expiresAt: Number(row.expires_at),
    status: String(row.status) as VaultKeyStatus,
    note: row.note === null ? undefined : String(row.note),
    createdAt: Number(row.created_at),
  };
}
