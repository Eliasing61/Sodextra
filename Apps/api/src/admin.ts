/**
 * The owner's admin view: server health, how much of the SoDEX connection budget is in
 * use, and who is running what. Read-only: it never touches a bot.
 */
import { readFileSync, statfsSync } from "node:fs";
import { cpus, freemem, loadavg, totalmem, uptime } from "node:os";

import { slotsUsed } from "./slots.ts";
import type { AdminBot, AdminUser, AdminView, BotListItem } from "./types.ts";

/** Memory programs can still use: MemAvailable on Linux (free memory counts cache as used). */
function memAvailable(): number {
  try {
    const kb = /MemAvailable:\s+(\d+) kB/.exec(readFileSync("/proc/meminfo", "utf8"))?.[1];
    if (kb) return Number(kb) * 1024;
  } catch {
    // not Linux
  }
  return freemem();
}

function disk(dir: string): { total: number | null; free: number | null } {
  try {
    const s = statfsSync(dir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return { total: null, free: null };
  }
}

export function serverStats(dataDir: string): AdminView["server"] {
  const d = disk(dataDir);
  return {
    uptimeSec: Math.round(uptime()),
    load: loadavg().map((l) => Math.round(l * 100) / 100),
    cpus: cpus().length,
    memTotal: totalmem(),
    memAvailable: memAvailable(),
    diskTotal: d.total,
    diskFree: d.free,
    apiRss: process.memoryUsage().rss,
    apiUptimeSec: Math.round(process.uptime()),
  };
}

/** Running bots and users from every live bot on the server (Funding Carry legs left out). */
export function adminBots(bots: { account: string; item: BotListItem }[]): {
  running: AdminBot[];
  users: AdminUser[];
  slotsUsed: number;
} {
  const online = bots.filter((b) => b.item.online);
  const running = online
    .map(({ account, item }) => ({
      id: item.id,
      name: item.name,
      account,
      strategy: item.strategy,
      symbol: item.symbol,
      status: item.status,
      statusReason: item.statusReason,
      volume: item.volume,
      volumeToday: item.volumeToday,
      pnl: item.pnl,
      run: item.run,
      today: item.today,
      updatedAt: item.updatedAt,
    }))
    .sort((a, b) => b.volumeToday - a.volumeToday);

  const byAccount = new Map<string, AdminUser>();
  for (const { account, item } of bots) {
    const u = byAccount.get(account) ?? {
      account,
      bots: 0,
      running: 0,
      volume: 0,
      volumeToday: 0,
      lastActive: 0,
    };
    u.bots += 1;
    if (item.online) u.running += 1;
    u.volume += item.volume;
    u.volumeToday += item.volumeToday;
    u.lastActive = Math.max(u.lastActive, item.updatedAt);
    byAccount.set(account, u);
  }
  const users = [...byAccount.values()].sort(
    (a, b) => b.running - a.running || b.lastActive - a.lastActive,
  );
  return { running, users, slotsUsed: slotsUsed(online.map((b) => b.item.strategy)) };
}
