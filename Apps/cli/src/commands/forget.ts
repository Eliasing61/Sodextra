import { SqliteStore, type BotRecord } from "@sodextra/engine-core";

import { DB_PATH } from "../env.ts";
import { lockHolder } from "../lock.ts";
import { c } from "../print.ts";

/**
 * Delete a stopped bot and everything recorded for it (sessions, fills, orders, events),
 * so it no longer counts in the dashboard, history, totals or admin. Nothing on SoDEX
 * changes: coins or a position it left stay in the account. Without --confirm it only
 * shows what would go.
 */
export async function forgetCommand(
  target: string,
  options: { confirm: boolean; id?: string | undefined },
): Promise<number> {
  const store = new SqliteStore(DB_PATH);
  try {
    const found = store
      .listBots()
      .filter((b) => b.id === target || b.name === target)
      .filter((b) => !options.id || b.id === options.id);
    if (found.length === 0) {
      console.log(c.red(`No bot named or with id "${target}".`));
      return 1;
    }
    if (found.length > 1) {
      console.log(`${found.length} bots match "${target}"; pick one with --id:`);
      for (const b of found) console.log(`  ${describe(store, b)}`);
      return 1;
    }
    const bot = found[0]!;
    const holder = lockHolder(bot.id);
    if (holder !== undefined) {
      console.log(c.red(`${bot.name} is running (process ${holder}). Stop it first.`));
      return 1;
    }
    const open = store.activeOrders(bot.id);
    if (open.length > 0) {
      console.log(
        c.red(
          `${bot.name} still has ${open.length} order(s) on record. Stop it with "stop" first so they are cancelled.`,
        ),
      );
      return 1;
    }
    console.log(describe(store, bot));
    if (!options.confirm) {
      console.log(
        c.yellow(
          `Run again with --confirm to delete this bot and its history. This can't be undone.`,
        ),
      );
      return 0;
    }
    store.deleteBot(bot.id);
    console.log(c.green(`Deleted ${bot.name} (${bot.id}) and its history.`));
    return 0;
  } finally {
    store.close();
  }
}

function describe(store: SqliteStore, b: BotRecord): string {
  const sessions = store.listSessions(b.id, 10_000).length;
  const fills = store.listFills(b.id).length;
  return `${b.name} — id ${b.id}, ${b.mode}, ${b.strategy} on ${b.symbol}, owner ${b.owner ?? "server account"}: ${sessions} run(s), ${fills} fill(s)`;
}
