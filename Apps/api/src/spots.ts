/**
 * Early access (temporary): how many people may run bots at once, so the server stays
 * inside SoDEX's per-IP limits (10 users, ~10 live connections). The owner's place is
 * always kept for them; everyone else shares the rest, first come, first served: a spot
 * opens when someone stops their last bot.
 */

/** Spots for people other than the owner. */
export interface Spots {
  total: number;
  left: number;
}

export const SPOTS_FULL =
  "All spots are taken right now. During early access Sodextra runs a limited number of bots at once; a spot opens when someone stops theirs. Try again a bit later.";

/** `people`: how many may run at once, the owner included. */
export function spots(
  runningAccounts: Iterable<string>,
  isOwner: (a: string) => boolean,
  people: number,
): Spots {
  const others = new Set([...runningAccounts].filter((a) => !isOwner(a)));
  const total = Math.max(0, people - 1);
  return { total, left: Math.max(0, total - others.size) };
}

/** Why this account can't take a spot now, if it can't (the owner, or one already running, can). */
export function spotBlock(
  account: string,
  runningAccounts: Iterable<string>,
  isOwner: (a: string) => boolean,
  people: number,
): string | undefined {
  const running = new Set(runningAccounts);
  if (isOwner(account) || running.has(account)) return undefined;
  return spots(running, isOwner, people).left > 0 ? undefined : SPOTS_FULL;
}
