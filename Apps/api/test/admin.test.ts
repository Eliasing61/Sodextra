import { describe, expect, it } from "vitest";

import { adminBots, serverStats } from "../src/admin.ts";
import type { BotListItem } from "../src/types.ts";

const item = (over: Partial<BotListItem>): BotListItem => ({
  id: "b",
  name: "b",
  strategy: "maker",
  symbol: "BTC-USD",
  market: "perps",
  mode: "live",
  status: "running",
  online: true,
  updatedAt: 1_000,
  volume: 100,
  volumeToday: 10,
  pnl: -0.1,
  costPerMillion: 100,
  position: 0,
  run: null,
  today: null,
  ...over,
});

const period = (volume: number, pnl: number) => ({
  since: 0,
  volume,
  fills: 1,
  fees: 0,
  makerShare: 1,
  pnl,
  costPerMillion: (-pnl / volume) * 1_000_000,
});

describe("admin view", () => {
  it("lists running bots, counts connection slots, and sums each user's bots", () => {
    const { running, users, slotsUsed } = adminBots([
      { account: "0xa", item: item({ id: "1", volumeToday: 5 }) },
      { account: "0xa", item: item({ id: "2", strategy: "carry", volumeToday: 50 }) },
      { account: "0xb", item: item({ id: "3", online: false, updatedAt: 9_000 }) },
    ]);
    expect(running.map((b) => b.id)).toEqual(["2", "1"]);
    expect(slotsUsed).toBe(3);
    expect(users).toEqual([
      expect.objectContaining({
        account: "0xa",
        bots: 2,
        running: 2,
        volume: 200,
      }),
      expect.objectContaining({
        account: "0xb",
        bots: 1,
        running: 0,
        lastActive: 9_000,
      }),
    ]);
  });

  it("passes each running bot's session and today figures through", () => {
    const run = period(40, -0.01);
    const today = period(25, -0.005);
    const { running } = adminBots([{ account: "0xa", item: item({ id: "1", run, today }) }]);
    expect(running[0]).toMatchObject({ run, today, volume: 100, pnl: -0.1 });
  });

  it("reads the machine's figures", () => {
    const s = serverStats(".");
    expect(s.cpus).toBeGreaterThan(0);
    expect(s.memAvailable).toBeLessThanOrEqual(s.memTotal);
    expect(s.load).toHaveLength(3);
  });
});
