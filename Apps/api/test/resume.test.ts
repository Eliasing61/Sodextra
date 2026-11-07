import { SqliteStore, type BotRecord } from "@sodextra/engine-core";
import { describe, expect, it } from "vitest";

import { botsToResume, SHUTDOWN_GRACE_MS } from "../src/resume.ts";

const BOOT = Date.UTC(2026, 9, 31, 12, 0, 0);
const MIN = 60_000;

function setup() {
  const store = new SqliteStore(":memory:");
  const add = (id: string, patch: Partial<BotRecord> = {}) => {
    store.createBot({
      id,
      name: id,
      strategy: "maker",
      symbol: "BTC-USD",
      market: "perps",
      mode: "live",
      config: {},
      status: "running",
      createdAt: BOOT - 600 * MIN,
      updatedAt: BOOT - 600 * MIN,
      ...patch,
    });
    store.setKV(id, "file", `/opt/sodextra/bots/web/${id}.json`);
  };
  const resume = (online: (id: string) => boolean = () => false) =>
    botsToResume(store, { bootTime: BOOT, online, fileExists: () => true }).map((c) => c.bot.id);
  return { store, add, resume };
}

describe("botsToResume", () => {
  it("resumes a bot whose session the shutdown closed", () => {
    const { store, add, resume } = setup();
    add("a");
    const s = store.startSession("a", BOOT - 300 * MIN);
    store.endSession(s, BOOT - 1 * MIN, "disconnected");
    expect(resume()).toEqual(["a"]);
  });

  it("resumes a bot whose session was never closed (power cut)", () => {
    const { store, add } = setup();
    add("a");
    const s = store.startSession("a", BOOT - 300 * MIN);
    const out = botsToResume(store, {
      bootTime: BOOT,
      online: () => false,
      fileExists: () => true,
    });
    expect(out.map((c) => c.bot.id)).toEqual(["a"]);
    expect(out[0]!.openSession?.id).toBe(s);
  });

  it("leaves stopped and paused bots alone", () => {
    const { store, add, resume } = setup();
    add("stopped", { status: "stopped" });
    add("paused", { status: "paused" });
    for (const id of ["stopped", "paused"]) store.startSession(id, BOOT - 300 * MIN);
    expect(resume()).toEqual([]);
  });

  it("leaves a bot disconnected long before the reboot", () => {
    const { store, add, resume } = setup();
    add("a");
    const s = store.startSession("a", BOOT - 300 * MIN);
    store.endSession(s, BOOT - SHUTDOWN_GRACE_MS - MIN, "disconnected");
    expect(resume()).toEqual([]);
  });

  it("does nothing for runs that started after boot or bots still online", () => {
    const { store, add, resume } = setup();
    add("after");
    store.startSession("after", BOOT + 5 * MIN);
    add("online");
    store.startSession("online", BOOT - 300 * MIN);
    expect(resume((id) => id === "online")).toEqual([]);
  });

  it("needs the bot's file", () => {
    const { store, add } = setup();
    add("a");
    store.startSession("a", BOOT - 300 * MIN);
    const out = botsToResume(store, {
      bootTime: BOOT,
      online: () => false,
      fileExists: () => false,
    });
    expect(out).toEqual([]);
  });
});
