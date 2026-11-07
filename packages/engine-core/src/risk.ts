import { canonicalDecimal, toDecimal } from "@sodextra/sodex-client";

/**
 * Per-bot limits chosen by the user, enforced by the engine for every strategy.
 * They live with the bot (bot file locally, bot settings on the website later),
 * so each bot can have its own. All are optional; `live` requires maxNotional.
 */
export interface BotRiskSettings {
  /** Max exposure in USDC on either side: |position| × mark plus resting orders that would add to that side. */
  maxNotional?: string | undefined;
  /** Max position size in the base coin, counting resting orders that would add to it. */
  maxPosition?: string | undefined;
  /** Stop the bot and close its position once total PnL falls to −maxLoss USDC. */
  maxLoss?: string | undefined;
  /** Max orders resting on the book at once. */
  maxOpenOrders?: number | undefined;
  /** Highest leverage the strategy may set (perps). */
  maxLeverage?: number | undefined;
}

export const RISK_FIELDS: Record<keyof BotRiskSettings, string> = {
  maxNotional: "max exposure (USDC)",
  maxPosition: "max position (base coin)",
  maxLoss: "max loss before stopping (USDC)",
  maxOpenOrders: "max open orders",
  maxLeverage: "max leverage",
};

/** Parse the `risk` block of a bot config. Throws with a readable message on bad input. */
export function parseRiskSettings(raw: unknown): BotRiskSettings {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error('"risk" must be an object');
  const r = raw as Record<string, unknown>;
  const unknown = Object.keys(r).filter((k) => !(k in RISK_FIELDS));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown risk setting(s): ${unknown.join(", ")}. Allowed: ${Object.keys(RISK_FIELDS).join(", ")}`,
    );
  }

  const positiveDecimal = (key: keyof BotRiskSettings): string | undefined => {
    const value = r[key];
    if (value === undefined) return undefined;
    let d;
    try {
      d = toDecimal(String(value));
    } catch {
      throw new Error(`risk.${key} must be a number`);
    }
    if (!d.gt(0)) throw new Error(`risk.${key} must be greater than 0`);
    return canonicalDecimal(d);
  };
  const positiveInt = (key: keyof BotRiskSettings): number | undefined => {
    const value = r[key];
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new Error(`risk.${key} must be a whole number ≥ 1`);
    return n;
  };

  return {
    maxNotional: positiveDecimal("maxNotional"),
    maxPosition: positiveDecimal("maxPosition"),
    maxLoss: positiveDecimal("maxLoss"),
    maxOpenOrders: positiveInt("maxOpenOrders"),
    maxLeverage: positiveInt("maxLeverage"),
  };
}

export function describeRisk(risk: BotRiskSettings): string {
  const parts = (Object.keys(RISK_FIELDS) as (keyof BotRiskSettings)[])
    .filter((k) => risk[k] !== undefined)
    .map((k) => `${RISK_FIELDS[k]} ${risk[k]}`);
  return parts.length > 0 ? parts.join(", ") : "none set";
}
