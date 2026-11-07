import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { loadBotFile } from "../src/bot-file.ts";

const dir = mkdtempSync(join(tmpdir(), "sodextra-cli-"));
const write = (name: string, body: unknown) => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
};

describe("bot files", () => {
  it("loads the committed example", () => {
    const file = loadBotFile(
      fileURLToPath(new URL("../../../bots/example-probe.json", import.meta.url)),
    );
    expect(file).toMatchObject({
      name: "probe-btc",
      strategyName: "probe",
      market: "perps",
      symbol: "BTC-USD",
    });
    expect(file.config).toEqual({
      side: "BUY",
      offsetPct: 3,
      repriceAtPct: 1,
      quantity: undefined,
    });
    expect(file.paper.quoteBalance).toBe("1000");
  });

  it("passes only strategy settings to the strategy", () => {
    const file = loadBotFile(
      write("a.json", { name: "a", strategy: "probe", symbol: "ETH-USD", offsetPct: 2 }),
    );
    expect(file.market).toBe("perps");
    expect(file.config).toMatchObject({ offsetPct: 2 });
  });

  it.each([
    [{ strategy: "probe", symbol: "BTC-USD" }, /name/],
    [{ name: "Bad Name", strategy: "probe", symbol: "BTC-USD" }, /name/],
    [{ name: "a", strategy: "nope", symbol: "BTC-USD" }, /Unknown strategy/],
    [{ name: "a", strategy: "probe", symbol: "BTC-USD", market: "futures" }, /market/],
    [{ name: "a", strategy: "probe" }, /symbol/],
  ])("rejects %j", (body, error) => {
    expect(() => loadBotFile(write("bad.json", body))).toThrow(error);
  });
});

describe("bot file risk block", () => {
  it("parses limits per bot", () => {
    const file = loadBotFile(
      write("r.json", {
        name: "r",
        strategy: "probe",
        symbol: "BTC-USD",
        risk: { maxNotional: 50, maxLoss: 5 },
      }),
    );
    expect(file.risk).toMatchObject({ maxNotional: "50", maxLoss: "5" });
    expect(file.config).not.toHaveProperty("risk");
  });

  it("points at the file when a limit is invalid", () => {
    const path = write("bad-risk.json", {
      name: "r",
      strategy: "probe",
      symbol: "BTC-USD",
      risk: { maxLoss: -1 },
    });
    expect(() => loadBotFile(path)).toThrow(/bad-risk\.json: risk\.maxLoss must be greater than 0/);
  });
});
