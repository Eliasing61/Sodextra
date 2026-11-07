import { toDecimal } from "@sodextra/sodex-client";
import { STRATEGIES } from "@sodextra/strategies";
import {
  totalPnl,
  type EngineStats,
  type PositionState,
  type SqliteStore,
  type BotRecord,
} from "@sodextra/engine-core";

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: number) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
export const c = { red: wrap(31), green: wrap(32), yellow: wrap(33), dim: wrap(2), bold: wrap(1) };

export function time(ms = Date.now()): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

export function logEvent(e: { level: "info" | "warn" | "error"; message: string }): void {
  const tag =
    e.level === "error" ? c.red("ERROR") : e.level === "warn" ? c.yellow("WARN ") : c.dim("info ");
  console.log(`${c.dim(time())} ${tag} ${e.message}`);
}

export function fmt(value: string | undefined, digits = 4): string {
  if (value === undefined) return "-";
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : value;
}

/** A price: 2 decimals for ordinary ones, 4 significant digits for tiny ones (PEPE 0.000004755). */
export function price(value: string): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return n === 0 || Math.abs(n) >= 1 ? n.toFixed(2) : String(Number(n.toPrecision(4)));
}

export function signed(value: string, digits = 4): string {
  const n = Number(value);
  const s = `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
  return n > 0 ? c.green(s) : n < 0 ? c.red(s) : s;
}

/** One bot's saved state as text (used by `status` and the periodic line while running). */
export function describeBot(store: SqliteStore, bot: BotRecord, mark?: string): string[] {
  const strategyLines = describeStrategy(store, bot);
  const engine = store.getKV<{ position: PositionState; stats?: EngineStats }>(bot.id, "engine");
  const p = engine?.position;
  const lines = [
    `${c.bold(bot.name)} ${c.dim(`[${bot.mode}]`)} ${bot.strategy} on ${bot.symbol} (${bot.market}) — ${statusText(bot)}`,
  ];
  if (p) {
    lines.push(
      `  position ${p.size} @ ${price(p.avgEntry)} | realised ${signed(p.realizedPnl)} | fees ${fmt(p.fees)} | ${p.fillCount} fills, volume ${fmt(p.volume, 2)}` +
        (mark ? ` | total PnL ${signed(totalPnl(p, mark))} @ ${mark}` : ""),
    );
  }
  if (p && engine?.stats && !toDecimal(p.volume).isZero()) {
    const volume = toDecimal(p.volume);
    const makerShare = toDecimal(engine.stats.makerVolume).div(volume).mul(100);
    const pnl = mark ? toDecimal(totalPnl(p, mark)) : toDecimal(p.realizedPnl).minus(p.fees);
    const costPerMillion = pnl.neg().div(volume).mul(1_000_000);
    lines.push(
      `  volume ${volume.toFixed(2)} USDC, ${makerShare.toFixed(1)}% maker | cost ${costPerMillion.toFixed(0)} USDC per $1M (${costPerMillion.div(100).toFixed(2)} bp) | ${engine.stats.actions} actions (${toDecimal(engine.stats.actions).div(volume).toFixed(3)} per $1)`,
    );
  }
  for (const line of strategyLines) lines.push(`  ${line}`);
  const active = store.activeOrders(bot.id);
  lines.push(`  ${active.length} active order(s)`);
  for (const o of active.slice(0, 15)) {
    lines.push(
      c.dim(
        `    ${o.key.padEnd(8)} ${o.side.padEnd(4)} ${o.quantity ?? "all"} @ ${o.price ?? o.stopPrice ?? "market"} ${o.status}${o.postOnly ? " post-only" : ""}`,
      ),
    );
  }
  return lines;
}

export function statusText(bot: BotRecord): string {
  const s =
    bot.status === "running"
      ? c.green(bot.status)
      : bot.status === "paused" || bot.status === "error"
        ? c.yellow(bot.status)
        : bot.status;
  return bot.statusReason ? `${s} (${bot.statusReason})` : s;
}

/** Strategy-specific lines from the strategy's saved state (e.g. grid round trips). */
function describeStrategy(store: SqliteStore, bot: BotRecord): string[] {
  const strategy = STRATEGIES[bot.strategy];
  const state = store.getKV<unknown>(bot.id, "strategy");
  if (!strategy?.describe || state === undefined) return [];
  try {
    return strategy.describe(bot.config, state);
  } catch {
    return [];
  }
}
