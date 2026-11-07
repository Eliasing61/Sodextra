import { appendFileSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { LOG_DIR, logFrom, logPathFor, startFailure, WEB_BOTS_DIR } from "../src/launcher.ts";

describe("bot log files", () => {
  it("keeps same-named bots of different wallets in separate logs", () => {
    const a = logPathFor(
      join(WEB_BOTS_DIR, "0xAbCd000000000000000000000000000000000001", "maker-btc.json"),
      "live",
    );
    const b = logPathFor(
      join(WEB_BOTS_DIR, "0x2222222222222222222222222222222222222222", "maker-btc.json"),
      "live",
    );
    expect(a).toBe(join(LOG_DIR, "0xabcd000000000000000000000000000000000001-maker-btc-live.log"));
    expect(a).not.toBe(b);
  });

  it("keeps the plain name for bot files outside a wallet folder", () => {
    expect(logPathFor(join("bots", "maker-btc.json"), "paper")).toBe(
      join(LOG_DIR, "maker-btc-paper.log"),
    );
  });
});

describe("startFailure", () => {
  it("names the start check's problems", () => {
    const output = [
      "grid-btc: grid on BTC-USD (perps), mainnet",
      "  Long grid 76277 – 77819, 10 grids (arithmetic), 100 USDC at 5x cross",
      "  ✗ investment 100 USDC is more than the 63.20 USDC available",
      "  1 problem(s); fix the config before running",
    ].join("\n");
    expect(startFailure(output)).toBe("Investment 100 USDC is more than the 63.20 USDC available");
  });

  it("or the error the bot stopped on", () => {
    expect(startFailure("grid-btc: grid on BTC-USD\nError: this key isn't active\n")).toBe(
      "This key isn't active",
    );
  });

  it("says in plain words when SoDEX couldn't be reached", () => {
    expect(
      startFailure("── start ──\nError: SoDEX /api/v1/perps/markets/symbols: network error\n"),
    ).toBe(
      "It couldn't reach SoDEX just now (a network hiccup, nothing wrong with your bot). Try again in a moment.",
    );
  });

  it("says nothing when the output has no reason", () => {
    expect(startFailure("grid-btc: grid on BTC-USD\n")).toBeUndefined();
  });
});

describe("logFrom", () => {
  it("reads a long log from its size in bytes, multi-byte characters and all", () => {
    const file = join(mkdtempSync(join(tmpdir(), "sx-log-")), "bot.log");
    // Earlier runs: lines full of 3-byte characters, as the real logs have.
    writeFileSync(file, "── started ──  ✓ config is valid  price 1 → 2\n".repeat(200));
    const offset = statSync(file).size;
    appendFileSync(file, "── this start ──\n  ✗ not enough balance\n");
    expect(logFrom(file, offset)).toBe("── this start ──\n  ✗ not enough balance\n");
  });
});
