import { Decimal as DecimalJs } from "decimal.js";

// SoDEX re-marshals decimals with Go's shopspring/decimal before checking a
// signature, so every decimal we sign must already be in that canonical form:
// no exponent, no leading "+", no leading zeros, no trailing zeros ("0.500" -> "0.5").

export type DecimalInput = string | number | DecimalJs;

const D = DecimalJs.clone({ precision: 60, toExpNeg: -100, toExpPos: 100 });

export function toDecimal(value: DecimalInput): DecimalJs {
  const d = new D(value);
  if (!d.isFinite()) throw new Error(`Not a finite decimal: ${String(value)}`);
  return d;
}

export function canonicalDecimal(value: DecimalInput): string {
  const d = toDecimal(value);
  return d.isZero() ? "0" : d.toFixed();
}

export function isCanonicalDecimal(value: string): boolean {
  try {
    return canonicalDecimal(value) === value;
  } catch {
    return false;
  }
}

export { D as Decimal };
