import type { Strategy } from "@sodextra/engine-core";

import { grid } from "./grid/grid.ts";
import { probe } from "./probe/probe.ts";

export { grid } from "./grid/grid.ts";
export type { GridState } from "./grid/grid.ts";
export * from "./grid/config.ts";
export * from "./grid/math.ts";
export { probe } from "./probe/probe.ts";
export type { ProbeConfig, ProbeState } from "./probe/probe.ts";

/**
 * Every strategy in this repository, by name. Sodextra's production strategies (Maker Volume,
 * Taker Volume, Edge, Spot Edge, Stock Edge and Funding Carry) implement the same Strategy
 * interface and are registered here in the production build; they are not part of this
 * repository.
 */
export const STRATEGIES: Record<string, Strategy<unknown, unknown>> = {
  grid: grid as unknown as Strategy<unknown, unknown>,
  probe: probe as unknown as Strategy<unknown, unknown>,
};

export function getStrategy(name: string): Strategy<unknown, unknown> {
  const strategy = Object.hasOwn(STRATEGIES, name) ? STRATEGIES[name] : undefined;
  if (!strategy) {
    throw new Error(`Unknown strategy "${name}". Available: ${Object.keys(STRATEGIES).join(", ")}`);
  }
  return strategy;
}
