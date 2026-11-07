/**
 * The server's own addresses that bots send their SoDEX traffic from (SODEXTRA_EGRESS_IPS,
 * comma-separated, the server's default address first). SoDEX allows, per IP, 10 users on
 * the private account feeds and 10 WebSocket connections. A running bot holds one connection
 * (Funding Carry two) and a live bot counts its owner as a user there. The API gives every
 * new bot an address with room, keeping one person's bots on one address so they count once.
 */

export const USERS_PER_ADDRESS = 10;
export const CONNECTIONS_PER_ADDRESS = 10;

/** The configured addresses; empty = every bot uses the server's default address. */
export function egressPool(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean),
    ),
  ];
}

/** A running (or starting) bot: where its traffic leaves from and what it uses there. */
export interface AddressUse {
  /** Undefined: started without one, so it uses the server's default address (the first). */
  address: string | undefined;
  account: string | undefined;
  /** Live bots open their owner's private feeds, which count as a user. */
  live: boolean;
  /** WebSocket connections it holds. */
  connections: number;
}

export interface AddressLoad {
  address: string;
  users: number;
  connections: number;
}

/** People and connections per address (addresses no longer configured still count). */
export function addressLoad(pool: string[], running: AddressUse[]): AddressLoad[] {
  const byAddress = new Map<string, { accounts: Set<string>; connections: number }>();
  for (const a of pool) byAddress.set(a, { accounts: new Set(), connections: 0 });
  for (const bot of running) {
    const address = bot.address ?? pool[0];
    if (address === undefined) continue;
    const entry = byAddress.get(address) ?? { accounts: new Set<string>(), connections: 0 };
    if (bot.live && bot.account) entry.accounts.add(bot.account);
    entry.connections += bot.connections;
    byAddress.set(address, entry);
  }
  return [...byAddress].map(([address, e]) => ({
    address,
    users: e.accounts.size,
    connections: e.connections,
  }));
}

/**
 * The address a new bot should use, or undefined when none has room. A person who already
 * runs a bot stays on that address while it has room; otherwise the least-used address.
 */
export function pickAddress(
  pool: string[],
  running: AddressUse[],
  bot: { account: string | undefined; live: boolean; connections: number },
): string | undefined {
  const there = (address: string) =>
    running.some((r) => r.live && r.account === bot.account && (r.address ?? pool[0]) === address);
  const fits = (l: AddressLoad) =>
    l.connections + bot.connections <= CONNECTIONS_PER_ADDRESS &&
    (!bot.live || there(l.address) || l.users < USERS_PER_ADDRESS);
  const load = addressLoad(pool, running).filter((l) => pool.includes(l.address));
  const own = bot.live && bot.account ? load.find((l) => there(l.address) && fits(l)) : undefined;
  if (own) return own.address;
  return load.filter(fits).sort((a, b) => a.users - b.users || a.connections - b.connections)[0]
    ?.address;
}
