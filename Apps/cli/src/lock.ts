import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LOCK_DIR } from "./env.ts";

/** Pid of a live process holding this bot's lock, if any. */
export function lockHolder(botId: string): number | undefined {
  const file = join(LOCK_DIR, `${botId}.pid`);
  if (!existsSync(file)) return undefined;
  const pid = Number(readFileSync(file, "utf8"));
  if (!Number.isInteger(pid) || pid === process.pid) return undefined;
  try {
    process.kill(pid, 0); // throws if the process is gone
    return pid;
  } catch {
    rmSync(file, { force: true });
    return undefined;
  }
}

/** One process per bot, so two terminals never trade the same bot. */
export function acquireLock(botId: string): () => void {
  const holder = lockHolder(botId);
  if (holder !== undefined) {
    throw new Error(
      `This bot is already running in another process (pid ${holder}). Stop that one first.`,
    );
  }
  mkdirSync(LOCK_DIR, { recursive: true });
  const file = join(LOCK_DIR, `${botId}.pid`);
  writeFileSync(file, String(process.pid));
  return () => rmSync(file, { force: true });
}
