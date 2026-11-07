import { isInteger, isSafeNumber, parse } from "lossless-json";

/**
 * SoDEX IDs are uint64. Parse integers that don't fit in a JS number as bigint
 * so order and trade IDs never lose precision; everything else is a number.
 */
export function parseJson(text: string): unknown {
  // Fast path: with no run of 16+ digits there's no integer above 2^53, so the built-in
  // parser gives the same result (most messages: prices are strings, IDs are small).
  if (!/\d{16}/.test(text)) return JSON.parse(text) as unknown;
  return parse(text, null, (value: string) => {
    if (isInteger(value) && !isSafeNumber(value)) return BigInt(value);
    return Number(value);
  });
}
