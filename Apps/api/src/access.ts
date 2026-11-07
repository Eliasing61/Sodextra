/**
 * Who may run which bot type.
 *
 * Invite-only bot types are open to the operator's wallet (SODEXTRA_OWNER_ADDRESS) and to the
 * wallets listed, comma-separated, in their own environment variable (INVITE_ONLY). Every other
 * bot type is open to every wallet, within the run spots (spots.ts).
 *
 * The website may only create the bot types in WEB_STRATEGIES; the others (probe, carry legs)
 * are run from the terminal or by another bot.
 */

/** Invite-only bot types, each with the environment variable listing its invited wallets. */
const INVITE_ONLY: Record<string, string> = {
  profit: "SODEXTRA_PROFIT_ADDRESSES",
  carry: "SODEXTRA_CARRY_ADDRESSES",
  "spot-profit": "SODEXTRA_SPOT_PROFIT_ADDRESSES",
  stock: "SODEXTRA_STOCK_ADDRESSES",
};

/** The wallet addresses in an environment variable (comma-separated), in lower case. */
function walletsIn(envVar: string): string[] {
  return (process.env[envVar] ?? "")
    .split(",")
    .map((a) => a.trim().toLowerCase())
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a));
}

/** The operator's wallet, when one is set. */
function owner(): string | undefined {
  return walletsIn("SODEXTRA_OWNER_ADDRESS")[0];
}

/** Bot types the website may create (POST /bots). */
export const WEB_STRATEGIES: readonly string[] = [
  "maker",
  "profit",
  "spot-profit",
  "stock",
  "taker",
  "carry",
  "grid",
];

/** Why the website can't create this bot type, if it can't. */
export function webCreateBlock(strategy: string): string | undefined {
  if (WEB_STRATEGIES.includes(strategy)) return undefined;
  return strategy
    ? `"${strategy}" bots can't be created from the website.`
    : "The bot file has no strategy.";
}

/** May this wallet run this bot type? */
export function mayRun(strategy: string, wallet: string | undefined): boolean {
  if (!Object.hasOwn(INVITE_ONLY, strategy)) return true;
  if (wallet === undefined) return false;
  const address = wallet.toLowerCase();
  return address === owner() || walletsIn(INVITE_ONLY[strategy]!).includes(address);
}

/** Bot types this wallet can't run (the website shows them locked). */
export function lockedFor(wallet: string): string[] {
  return Object.keys(INVITE_ONLY).filter((strategy) => !mayRun(strategy, wallet));
}

/** Is this the operator's wallet? (It sees the admin view and always has a run spot.) */
export function isOwner(wallet: string): boolean {
  const operator = owner();
  return operator !== undefined && wallet.toLowerCase() === operator;
}

/** Why a wallet can't run this bot type. */
export function inviteOnlyMessage(strategy: string): string {
  if (strategy === "spot-profit") return "Spot Edge is invite-only while it's tested live.";
  if (strategy === "stock") return "Stock Edge is invite-only while it's tested live.";
  return strategy === "carry"
    ? "The Funding Carry bot is invite-only while it's tested live."
    : "Edge is invite-only for now: it earns from a few small markets, and more users would split the same profit.";
}
