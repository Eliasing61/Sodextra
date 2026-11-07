import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { privateKeyToAddress } from "viem/accounts";
import { describe, expect, it } from "vitest";

import { KeyVault, NOT_LISTED_YET } from "../src/vault.ts";

const OWNER = "0x00000000000000000000000000000000000000aa" as const;

function vault(master = randomBytes(32)) {
  return new KeyVault({ dbPath: ":memory:", masterKey: master });
}

describe("KeyVault", () => {
  it("generates a key, keeps it sealed, and opens it only once active", () => {
    const v = vault();
    const key = v.createPending({
      name: "bot-1",
      owner: OWNER,
      accountId: 1061,
      permissions: 14,
      expiresAt: Date.now() + 1e9,
    });
    expect(key.status).toBe("pending");
    expect(() => v.privateKey(key.id)).toThrow(/isn't active/);
    expect(v.activeFor(OWNER)).toBeUndefined();

    v.setStatus(key.id, "active");
    const pk = v.privateKey(key.id);
    expect(privateKeyToAddress(pk)).toBe(key.address);
    expect(v.activeFor(OWNER)?.id).toBe(key.id);
    // list() never carries secrets
    expect(JSON.stringify(v.list(OWNER))).not.toContain(pk.slice(2));
  });

  it("can't open a key with the wrong master key", () => {
    const dbPath = join(mkdtempSync(join(tmpdir(), "sx-vault-")), "vault.db");
    const v = new KeyVault({ dbPath, masterKey: randomBytes(32) });
    const key = v.createPending({
      name: "bot-1",
      owner: OWNER,
      accountId: 1,
      permissions: 14,
      expiresAt: Date.now() + 1e9,
    });
    v.setStatus(key.id, "active");
    v.close();
    // Same database file, different master key: GCM authentication fails.
    const other = new KeyVault({ dbPath, masterKey: randomBytes(32) });
    expect(other.get(key.id)?.status).toBe("active");
    expect(() => other.privateKey(key.id)).toThrow(/authenticate|Unsupported state/);
    other.close();
  });

  it("ignores expired keys", () => {
    const v = vault();
    const key = v.createPending({
      name: "old",
      owner: OWNER,
      accountId: 1,
      permissions: 14,
      expiresAt: 1_000,
    });
    v.setStatus(key.id, "active");
    expect(v.activeFor(OWNER, 2_000)).toBeUndefined();
  });

  it("rejects a master key of the wrong size", () => {
    expect(() => KeyVault.masterKeyFromEnv(Buffer.alloc(16).toString("base64"))).toThrow(
      /32 bytes/,
    );
    expect(KeyVault.masterKeyFromEnv(undefined)).toBeUndefined();
  });

  it("prunes pending keys that were never registered", () => {
    const v = vault();
    const key = v.createPending({
      name: "p",
      owner: OWNER,
      accountId: 1,
      permissions: 14,
      expiresAt: Date.now() + 1e9,
      now: 1_000,
    });
    v.prunePending(60_000, 1_000_000);
    expect(v.get(key.id)).toBeUndefined();
  });

  it("keeps a key SoDEX accepted but hadn't listed for a day, then prunes it", () => {
    const v = vault();
    const key = v.createPending({
      name: "slow",
      owner: OWNER,
      accountId: 1,
      permissions: 14,
      expiresAt: Date.now() + 1e9,
      now: 1_000,
    });
    v.setStatus(key.id, "failed", NOT_LISTED_YET);
    v.prunePending(60_000, 1_000_000);
    expect(v.get(key.id)?.note).toBe(NOT_LISTED_YET);
    v.prunePending(60_000, 1_000 + 25 * 3600_000);
    expect(v.get(key.id)).toBeUndefined();
  });
});
