import { describe, expect, it } from "vitest";

import { kept } from "../src/kept.ts";

const tick = () => new Promise((r) => setImmediate(r));

describe("kept", () => {
  it("computes once, then answers with the kept value and refreshes it after answering", async () => {
    let now = 0;
    let calls = 0;
    const get = kept(
      () => ++calls,
      60_000,
      () => now,
    );

    expect(await get()).toBe(1);
    now = 30_000;
    expect(await get()).toBe(1);
    expect(calls).toBe(1);

    // Older than a minute: the old value at once, the new one computed behind it.
    now = 61_000;
    expect(await get()).toBe(1);
    expect(calls).toBe(1);
    await tick();
    await tick();
    expect(calls).toBe(2);
    expect(await get()).toBe(2);
  });

  it("tries again after a failed computation", async () => {
    let fail = true;
    const get = kept(() => {
      if (fail) throw new Error("db busy");
      return "ok";
    }, 60_000);
    await expect(get()).rejects.toThrow("db busy");
    fail = false;
    expect(await get()).toBe("ok");
  });
});
