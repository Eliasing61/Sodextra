import { describe, expect, it } from "vitest";

import { addressLoad, egressPool, pickAddress, type AddressUse } from "../src/egress.ts";

const POOL = ["203.0.113.10", "198.51.100.20", "2001:db8::1"];
const live = (account: string, address?: string, connections = 1): AddressUse => ({
  address,
  account,
  live: true,
  connections,
});
const people = (n: number, address: string) =>
  Array.from({ length: n }, (_, i) => live(`0x${address}-${i}`, address));

describe("egress addresses", () => {
  it("reads the configured addresses", () => {
    expect(egressPool(" 203.0.113.10, 198.51.100.20 ,,203.0.113.10")).toEqual([
      "203.0.113.10",
      "198.51.100.20",
    ]);
    expect(egressPool(undefined)).toEqual([]);
  });

  it("counts bots started without an address on the default (first) address", () => {
    const load = addressLoad(POOL, [live("0xa"), live("0xb", POOL[1])]);
    expect(load.map((l) => [l.users, l.connections])).toEqual([
      [1, 1],
      [1, 1],
      [0, 0],
    ]);
  });

  it("fills the least-used address and keeps a person's bots together", () => {
    const running = [...people(3, POOL[0]!), ...people(1, POOL[1]!)];
    expect(pickAddress(POOL, running, { account: "0xnew", live: true, connections: 1 })).toBe(
      POOL[2],
    );
    // 0xPOOL0-0 already runs on the first address: their next bot goes there too.
    expect(
      pickAddress(POOL, running, { account: `0x${POOL[0]}-0`, live: true, connections: 1 }),
    ).toBe(POOL[0]);
  });

  it("allows 10 people and 10 connections per address, and says when the server is full", () => {
    const full = POOL.flatMap((a) => people(10, a));
    expect(
      pickAddress(POOL, full, { account: "0xnew", live: true, connections: 1 }),
    ).toBeUndefined();
    // Someone already on a full address still fits there while it has connections left...
    const nine = [...people(9, POOL[0]!), live("0xme", POOL[0])];
    expect(
      pickAddress([POOL[0]!], nine, { account: "0xme", live: true, connections: 1 }),
    ).toBeUndefined();
    const roomy = [...people(8, POOL[0]!), live("0xme", POOL[0])];
    expect(pickAddress([POOL[0]!], roomy, { account: "0xme", live: true, connections: 1 })).toBe(
      POOL[0],
    );
    // ...and a Funding Carry bot needs two free connections on one address.
    const tight = POOL.flatMap((a) => people(9, a));
    expect(
      pickAddress(POOL, tight, { account: "0xnew", live: true, connections: 2 }),
    ).toBeUndefined();
  });

  it("counts paper bots as connections but not as people", () => {
    const paper: AddressUse = { address: POOL[0], account: "0xp", live: false, connections: 1 };
    expect(addressLoad([POOL[0]!], [paper])[0]).toMatchObject({ users: 0, connections: 1 });
  });
});
