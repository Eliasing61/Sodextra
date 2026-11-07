import { describe, expect, it } from "vitest";

import { NOT_LISTED_YET, type VaultKey } from "@sodextra/cli/vault";

import { checkActiveKey, sodextraKeysOn } from "../src/keys.ts";

const OWNER = "0x00000000000000000000000000000000000000aa";

function setup(
  listed: { perps: string[]; spot: string[] } | "down",
  id = "k1",
  { unlisted = false }: { unlisted?: boolean } = {},
) {
  const key = {
    id,
    name: `sodextra-${id}`,
    address: "0xAbC0000000000000000000000000000000000001",
    accountId: 1061,
    expiresAt: Date.now() + 1e9,
    status: unlisted ? "failed" : "active",
    note: unlisted ? NOT_LISTED_YET : undefined,
  } as unknown as VaultKey;
  const statuses: [string, string, string | undefined][] = [];
  let active: VaultKey | undefined = unlisted ? undefined : key;
  const vault = {
    activeFor: () => active,
    list: () => [key],
    setStatus: (keyId: string, status: string, note?: string) => {
      statuses.push([keyId, status, note]);
      active = status === "active" ? key : undefined;
    },
  };
  let calls = 0;
  const client = {
    user: {
      apiKeys: async () => {
        calls += 1;
        if (listed === "down") throw new Error("SoDEX unreachable");
        const row = (publicKey: string) => ({ publicKey, name: publicKey });
        return { perps: listed.perps.map(row), spot: listed.spot.map(row) };
      },
    },
  };
  return {
    vault: vault as unknown as Parameters<typeof checkActiveKey>[0],
    client: client as unknown as Parameters<typeof checkActiveKey>[1],
    statuses,
    calls: () => calls,
  };
}

describe("checkActiveKey", () => {
  it("retires a key that was deleted on SoDEX", async () => {
    const s = setup({ perps: [], spot: [] }, "gone");
    await checkActiveKey(s.vault, s.client, OWNER);
    expect(s.statuses).toEqual([["gone", "failed", "Deleted on SoDEX"]]);
  });

  it("keeps a key SoDEX still lists, and asks again only after a minute", async () => {
    const s = setup({ perps: ["0xabc0000000000000000000000000000000000001"], spot: [] }, "kept");
    await checkActiveKey(s.vault, s.client, OWNER);
    await checkActiveKey(s.vault, s.client, OWNER);
    expect(s.statuses).toEqual([]);
    expect(s.calls()).toBe(1);
  });

  it("trusts the vault while SoDEX can't be reached", async () => {
    const s = setup("down", "offline");
    await checkActiveKey(s.vault, s.client, OWNER);
    expect(s.statuses).toEqual([]);
  });

  it("turns on a key SoDEX accepted late, once both engines list it", async () => {
    const both = "0xabc0000000000000000000000000000000000001";
    const s = setup({ perps: [both], spot: [both] }, "late", { unlisted: true });
    await checkActiveKey(s.vault, s.client, OWNER);
    expect(s.statuses).toEqual([["late", "active", undefined]]);
  });

  it("leaves a late key off while SoDEX still doesn't list it", async () => {
    const s = setup({ perps: [], spot: [] }, "later", { unlisted: true });
    await checkActiveKey(s.vault, s.client, OWNER);
    expect(s.statuses).toEqual([]);
  });
});

describe("sodextraKeysOn", () => {
  it("names the account's earlier Sodextra keys (to revoke one), not SoDEX's own", async () => {
    const client = {
      user: {
        apiKeys: async () => ({
          perps: [
            { name: "sodextra-20261101-ab12" },
            { name: "web-login" },
            { name: "sodextra-new" },
          ],
          spot: [{ name: "sodextra-20261101-ab12" }, { name: "phone" }],
        }),
      },
    } as unknown as Parameters<typeof sodextraKeysOn>[0];
    expect(await sodextraKeysOn(client, OWNER, 1061, "sodextra-new")).toEqual([
      "sodextra-20261101-ab12",
    ]);
  });
});
