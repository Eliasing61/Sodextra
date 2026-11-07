/**
 * How much of the server's SoDEX connection budget a running bot takes. SoDEX allows 10
 * live connections per IP and every bot engine holds one: a Funding Carry bot runs two
 * engines (perps and spot), so it takes two slots.
 */
export function slotsFor(strategy: string): number {
  return strategy === "carry" ? 2 : 1;
}

/** Slots in use by these running bots. */
export function slotsUsed(strategies: string[]): number {
  return strategies.reduce((sum, s) => sum + slotsFor(s), 0);
}

/** Whether a bot of this type still fits under the server's slot limit. */
export function fits(running: string[], strategy: string, limit: number): boolean {
  return slotsUsed(running) + slotsFor(strategy) <= limit;
}
