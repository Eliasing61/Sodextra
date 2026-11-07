import { privateKeyToAccount } from "viem/accounts";
import { createSiweMessage } from "viem/siwe";
import { describe, expect, it } from "vitest";

import { Auth, COOKIE } from "../src/auth.ts";

// Throwaway test keys (never used anywhere else).
const OWNER = privateKeyToAccount(`0x${"11".repeat(32)}`);
const STRANGER = privateKeyToAccount(`0x${"22".repeat(32)}`);
const ORIGIN = "https://sodextra.xyz";
const T0 = Date.UTC(2026, 9, 31, 12, 0, 0);

function setup() {
  let now = T0;
  const auth = new Auth({
    dbPath: ":memory:",
    allowed: [OWNER.address],
    origins: [ORIGIN],
    now: () => now,
  });
  return { auth, advance: (ms: number) => (now += ms) };
}

function message(
  nonce: string,
  over: Partial<Parameters<typeof createSiweMessage>[0]> = {},
  address = OWNER.address,
) {
  return createSiweMessage({
    domain: "sodextra.xyz",
    uri: ORIGIN,
    address,
    version: "1",
    chainId: 286623,
    nonce,
    issuedAt: new Date(T0),
    expirationTime: new Date(T0 + 5 * 60_000),
    statement: "Sign in to Sodextra.",
    ...over,
  });
}

const cookieOf = (token: string) => `other=1; ${COOKIE}=${token}`;

describe("wallet sign-in", () => {
  it("signs in the allowed wallet and recognises its session cookie", async () => {
    const { auth } = setup();
    const msg = message(auth.issueNonce());
    const r = await auth.signIn(msg, await OWNER.signMessage({ message: msg }), "ip1");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(auth.session(cookieOf(r.token))).toBe(OWNER.address);
    expect(auth.cookie(r.token, r.expiresAt)).toMatch(/HttpOnly; SameSite=Strict; Secure$/);
    auth.signOut(cookieOf(r.token));
    expect(auth.session(cookieOf(r.token))).toBeUndefined();
  });

  it("refuses a wallet that isn't on the allowlist", async () => {
    const { auth } = setup();
    const msg = message(auth.issueNonce(), {}, STRANGER.address);
    const r = await auth.signIn(msg, await STRANGER.signMessage({ message: msg }), "ip1");
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/isn't allowed/) });
  });

  it("refuses a signature from a different key than the message claims", async () => {
    const { auth } = setup();
    const msg = message(auth.issueNonce());
    const r = await auth.signIn(msg, await STRANGER.signMessage({ message: msg }), "ip1");
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/doesn't match/) });
  });

  it("uses each nonce once and rejects unknown ones", async () => {
    const { auth } = setup();
    const msg = message(auth.issueNonce());
    const sig = await OWNER.signMessage({ message: msg });
    expect((await auth.signIn(msg, sig, "ip1")).ok).toBe(true);
    expect((await auth.signIn(msg, sig, "ip1")).ok).toBe(false); // replay
    const forged = message("abcdefgh12345678");
    expect(
      (await auth.signIn(forged, await OWNER.signMessage({ message: forged }), "ip1")).ok,
    ).toBe(false);
  });

  it("rejects messages for another site", async () => {
    const { auth } = setup();
    const msg = message(auth.issueNonce(), { domain: "evil.example", uri: "https://evil.example" });
    const r = await auth.signIn(msg, await OWNER.signMessage({ message: msg }), "ip1");
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/different site/) });
  });

  it("rejects stale nonces and old messages", async () => {
    const { auth, advance } = setup();
    const msg = message(auth.issueNonce());
    advance(6 * 60_000);
    const r = await auth.signIn(msg, await OWNER.signMessage({ message: msg }), "ip1");
    expect(r.ok).toBe(false);
  });

  it("requires a short expiry on the message", async () => {
    const { auth } = setup();
    const msg = message(auth.issueNonce(), { expirationTime: new Date(T0 + 24 * 3600_000) });
    const r = await auth.signIn(msg, await OWNER.signMessage({ message: msg }), "ip1");
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/short expiry/) });
  });

  it("expires sessions", async () => {
    const { auth, advance } = setup();
    const msg = message(auth.issueNonce());
    const r = await auth.signIn(msg, await OWNER.signMessage({ message: msg }), "ip1");
    if (!r.ok) throw new Error(r.reason);
    advance(8 * 24 * 3600_000);
    expect(auth.session(cookieOf(r.token))).toBeUndefined();
  });

  it("rate-limits repeated attempts from one client", async () => {
    const { auth } = setup();
    for (let i = 0; i < 10; i++) await auth.signIn("x", "0x00", "ip9");
    const r = await auth.signIn("x", "0x00", "ip9");
    expect(r).toEqual({ ok: false, reason: expect.stringMatching(/Too many/) });
  });

  it("ignores made-up session cookies", () => {
    const { auth } = setup();
    expect(auth.session(cookieOf("not-a-real-token"))).toBeUndefined();
    expect(auth.session(undefined)).toBeUndefined();
  });

  it("lets any wallet sign in when the allowlist is *", async () => {
    const auth = new Auth({ dbPath: ":memory:", allowed: ["*"], origins: [ORIGIN], now: () => T0 });
    const nonce = auth.issueNonce();
    const msg = message(nonce, {}, STRANGER.address);
    const ok = await auth.signIn(msg, await STRANGER.signMessage({ message: msg }), "1.2.3.4");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(auth.session(cookieOf(ok.token))).toBe(STRANGER.address);
  });

  it("refuses to start without an allowlist", () => {
    expect(() => new Auth({ dbPath: ":memory:", allowed: [], origins: [ORIGIN] })).toThrow(
      /No allowed sign-in address/,
    );
  });
});
