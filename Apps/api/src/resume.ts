/**
 * Auto-resume after a server restart (SODEXTRA_AUTO_RESUME=1, set on the VPS).
 *
 * A reboot ends every bot process: systemd's SIGTERM makes a bot cancel its quotes
 * and close its session as "disconnected"; a power cut leaves the session open.
 * Either way the bot's status stays "running". On start, the API relaunches the bots
 * that were running when the machine went down, and nothing else: stopped and
 * paused bots stay as they are, and so does a bot that was disconnected on purpose
 * long before the reboot.
 */
import { existsSync } from "node:fs";

import type { BotRecord, SessionRecord, SqliteStore } from "@sodextra/engine-core";

/** A session closed this long before boot still counts as "ended by the shutdown". */
export const SHUTDOWN_GRACE_MS = 10 * 60_000;

export interface ResumeCandidate {
  bot: BotRecord;
  path: string;
  /** The run that the restart cut short, still open (power cut, crash). */
  openSession?: SessionRecord | undefined;
}

export function botsToResume(
  store: SqliteStore,
  options: {
    /** When this machine booted (ms). */
    bootTime: number;
    online: (id: string) => boolean;
    fileExists?: (path: string) => boolean;
  },
): ResumeCandidate[] {
  const fileExists = options.fileExists ?? existsSync;
  const out: ResumeCandidate[] = [];
  for (const bot of store.listBots()) {
    if (bot.mode !== "live" && bot.mode !== "paper") continue;
    if (bot.status !== "running" || options.online(bot.id)) continue;
    const path = store.getKV<string>(bot.id, "file");
    if (!path || !fileExists(path)) continue;
    const last = store.listSessions(bot.id, 1)[0];
    if (!last || last.startedAt >= options.bootTime) continue;
    if (last.endedAt === undefined) {
      out.push({ bot, path, openSession: last });
    } else if (
      last.endReason === "disconnected" &&
      last.endedAt <= options.bootTime &&
      last.endedAt >= options.bootTime - SHUTDOWN_GRACE_MS
    ) {
      out.push({ bot, path });
    }
  }
  return out;
}
