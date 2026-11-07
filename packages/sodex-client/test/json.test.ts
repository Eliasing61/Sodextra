import { describe, expect, it } from "vitest";

import { parseJson } from "../src/json.ts";

describe("parseJson", () => {
  it("parses ordinary messages like JSON.parse (prices are strings, IDs small)", () => {
    const text =
      '{"channel":"bookTicker","data":[{"s":"BTC-USD","b":"77000.5","a":"77001","t":7006211,"q":0.5}]}';
    expect(parseJson(text)).toEqual(JSON.parse(text));
  });

  it("keeps uint64 IDs above 2^53 exact as bigint", () => {
    const parsed = parseJson('{"orderID":18446744073709551615,"tradeID":12,"px":"1.5"}') as {
      orderID: unknown;
      tradeID: unknown;
    };
    expect(parsed.orderID).toBe(18446744073709551615n);
    expect(parsed.tradeID).toBe(12);
  });

  it("long decimal strings take the careful path and still read the same", () => {
    const text = '{"av":"137.93921004423056919912961748","aid":1061}';
    expect(parseJson(text)).toEqual({ av: "137.93921004423056919912961748", aid: 1061 });
  });
});
