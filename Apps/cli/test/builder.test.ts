import { afterEach, describe, expect, it, vi } from "vitest";

const BUILDER_WALLET = "0xCCCC000000000000000000000000000000000003";
const OTHER = "0x1111111111111111111111111111111111111111";

/** env.ts reads its settings once, when loaded: load a fresh copy with these variables. */
async function loadEnv(vars: Record<string, string>) {
  vi.resetModules();
  for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
  return import("../src/env.ts");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("Sodextra builder code on bot orders", () => {
  it("is builder 1061 at 0.2 bp (fee 2) by default", async () => {
    const { builder } = await loadEnv({});
    expect(builder).toMatchObject({ id: 1061, fee: 2 });
  });

  it("goes on other wallets' bots, never on the builder's own", async () => {
    const { builderFor } = await loadEnv({ SODEXTRA_BUILDER_OWNER: BUILDER_WALLET });
    expect(builderFor(OTHER)).toEqual({ id: 1061, fee: 2 });
    expect(builderFor(BUILDER_WALLET.toLowerCase())).toBeUndefined();
    expect(builderFor(undefined)).toBeUndefined();
  });

  it("is off with builder ID 0", async () => {
    const { builderFor } = await loadEnv({ SODEXTRA_BUILDER_ID: "0" });
    expect(builderFor(OTHER)).toBeUndefined();
  });
});
