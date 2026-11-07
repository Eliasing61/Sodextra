import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { SqliteStore } from "../src/index.ts";

describe("SqliteStore sessions", () => {
  it("records runs per bot, newest first, and closes each only once", () => {
    const store = new SqliteStore(":memory:");
    const a = store.startSession("bot-a", 1_000);
    store.endSession(a, 2_000, "disconnected");
    store.endSession(a, 9_000, "stopped: later"); // ignored: already closed
    const b = store.startSession("bot-a", 3_000);
    store.startSession("bot-b", 3_500);

    const sessions = store.listSessions("bot-a");
    expect(sessions.map((s) => s.id)).toEqual([b, a]);
    expect(sessions[1]).toMatchObject({
      startedAt: 1_000,
      endedAt: 2_000,
      endReason: "disconnected",
    });
    expect(sessions[0]!.endedAt).toBeUndefined();
    expect(store.listSessions()).toHaveLength(3);
  });

  it("drops a run whose start failed, so the last real run shows again", () => {
    const store = new SqliteStore(":memory:");
    const real = store.startSession("bot-a", 1_000);
    store.endSession(real, 2_000, "stopped: stopped from the dashboard");
    store.dropSession(store.startSession("bot-a", 3_000));
    expect(store.listSessions("bot-a").map((s) => s.id)).toEqual([real]);
  });

  it("removes a bot's sessions with the bot", () => {
    const store = new SqliteStore(":memory:");
    store.createBot({
      id: "x",
      name: "x",
      strategy: "probe",
      symbol: "BTC-USD",
      market: "perps",
      mode: "paper",
      config: {},
      status: "created",
      createdAt: 0,
      updatedAt: 0,
    });
    store.startSession("x", 1);
    store.deleteBot("x");
    expect(store.listSessions("x")).toEqual([]);
  });
});

describe("SqliteStore bot owners", () => {
  const bot = (id: string, owner?: string) => ({
    id,
    name: "maker-btc",
    strategy: "maker",
    symbol: "BTC-USD",
    market: "perps" as const,
    mode: "live" as const,
    ...(owner ? { owner } : {}),
    config: {},
    status: "created" as const,
    createdAt: 0,
    updatedAt: 0,
  });

  it("keeps bot names unique per owner, not across owners", () => {
    const store = new SqliteStore(":memory:");
    store.createBot(bot("a"));
    store.createBot(bot("b", "0xAAAA000000000000000000000000000000000001"));
    store.createBot(bot("c", "0xbbbb000000000000000000000000000000000002"));
    expect(store.findBot("maker-btc", "live")?.id).toBe("a");
    expect(
      store.findBot("maker-btc", "live", "0xaaaa000000000000000000000000000000000001")?.id,
    ).toBe("b");
    expect(store.getBot("b")?.owner).toBe("0xaaaa000000000000000000000000000000000001");
    expect(store.getBot("a")?.owner).toBeUndefined();
    expect(() => store.createBot(bot("d", "0xbbbb000000000000000000000000000000000002"))).toThrow();
  });

  it("upgrades a database from before owners", () => {
    const dir = mkdtempSync(join(tmpdir(), "sx-store-"));
    const path = join(dir, "old.db");
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE bots (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, strategy TEXT NOT NULL, symbol TEXT NOT NULL,
        market TEXT NOT NULL, mode TEXT NOT NULL, config TEXT NOT NULL, status TEXT NOT NULL,
        status_reason TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        UNIQUE (name, mode)
      );
      INSERT INTO bots VALUES ('old', 'maker-btc', 'maker', 'BTC-USD', 'perps', 'live', '{}', 'running', NULL, 1, 2);
    `);
    old.close();
    const store = new SqliteStore(path);
    expect(store.findBot("maker-btc", "live")).toMatchObject({ id: "old", status: "running" });
    store.createBot(bot("new", "0xaaaa000000000000000000000000000000000001"));
    expect(store.listBots()).toHaveLength(2);
    store.close();
    new SqliteStore(path).close(); // opening again is a no-op
    rmSync(dir, { recursive: true, force: true });
  });
});
