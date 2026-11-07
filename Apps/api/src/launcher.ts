import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import { loadBotFile } from "@sodextra/cli/bot-file";
import { DATA_DIR, ROOT } from "@sodextra/cli/env";

/** Bot files created from the website (git-ignored). */
export const WEB_BOTS_DIR = join(ROOT, "bots", "web");
export const LOG_DIR = join(DATA_DIR, "logs");

const CLI_MAIN = join(ROOT, "apps", "cli", "src", "main.ts");
/** tsx's ESM loader: the bot runs in the spawned process itself (so its pid holds the lock). */
const TSX_LOADER = pathToFileURL(createRequire(join(ROOT, "package.json")).resolve("tsx")).href;
const START_TIMEOUT_MS = 45_000;
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

export interface LaunchResult {
  ok: boolean;
  message: string;
  /** The tail of the bot's log when it failed to start. */
  log?: string;
}

/**
 * Write a bot file sent by the website to bots/web/<name>.json, after checking it
 * with the CLI's own loader (same validation as a hand-written file).
 */
export function writeWebBotFile(raw: Record<string, unknown>): string {
  const name = String(raw.name ?? "");
  if (!NAME_RE.test(name)) {
    throw new Error('"name" must be 1–40 lowercase letters, digits, - or _');
  }
  // Each wallet's bots in their own folder, so names only need to be unique per wallet.
  const owner = raw.owner === undefined ? "" : String(raw.owner).toLowerCase();
  if (owner && !/^0x[0-9a-f]{40}$/.test(owner)) throw new Error("owner must be a wallet address");
  const dir = owner ? join(WEB_BOTS_DIR, owner) : WEB_BOTS_DIR;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`);
  try {
    loadBotFile(tmp);
  } catch (error) {
    rmSync(tmp, { force: true });
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(message.replace(`${tmp}: `, ""), { cause: error });
  }
  renameSync(tmp, path);
  return path;
}

/**
 * The bot's log file. Website bots live in bots/web/<wallet>/<name>.json and different
 * wallets often pick the same name (maker-btc), so the wallet is part of the file name.
 */
export function logPathFor(path: string, mode: string): string {
  const folder = basename(dirname(path));
  const wallet = /^0x[0-9a-fA-F]{40}$/.test(folder) ? `${folder.toLowerCase()}-` : "";
  return join(LOG_DIR, `${wallet}${basename(path, ".json")}-${mode}.log`);
}

/**
 * Start `npm run bot -- <mode> <file>` as a background process that outlives the
 * API, logging to .sodextra/logs/. Resolves once the bot holds its lock (it is
 * running) or the process exits (validation or a start check failed).
 */
export async function launchBot(options: {
  path: string;
  mode: "paper" | "live";
  /** Written to the log before the bot's output. */
  note?: string;
  /** True once a process other than this one holds the bot's lock. */
  isRunning: (pid: number) => boolean;
  /** Extra environment for the bot, e.g. SODEXTRA_EGRESS_IP (the address it trades from). */
  env?: Record<string, string>;
}): Promise<LaunchResult> {
  const { path, mode } = options;
  mkdirSync(LOG_DIR, { recursive: true });
  const log = logPathFor(path, mode);
  const offset = existsSync(log) ? statSync(log).size : 0;
  const fd = openSync(log, "a");
  // Which of the server's addresses it trades from: a start failing only on one shows here.
  const via = options.env?.SODEXTRA_EGRESS_IP ? ` · from ${options.env.SODEXTRA_EGRESS_IP}` : "";
  writeFileSync(
    fd,
    `\n── ${new Date().toISOString()} ${options.note ?? "started from the dashboard"}${via} ──\n`,
  );

  const child = spawn(
    process.execPath,
    ["--import", TSX_LOADER, CLI_MAIN, mode, path, ...(mode === "live" ? ["--confirm"] : [])],
    {
      cwd: ROOT,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", fd, fd],
      env: { ...process.env, ...options.env, NO_COLOR: "1" },
    },
  );
  child.unref();
  closeSync(fd);

  let exitCode: number | null | undefined;
  child.on("exit", (code) => {
    exitCode = code;
  });

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    if (child.pid !== undefined && options.isRunning(child.pid)) {
      return {
        ok: true,
        message: mode === "live" ? "Started. Quoting shortly." : "Started (paper).",
      };
    }
    if (exitCode !== undefined) {
      const output = logFrom(log, offset);
      const reason = startFailure(output);
      return {
        ok: false,
        message: reason ? `The bot did not start: ${reason}` : "The bot did not start.",
        log: tail(output, 14),
      };
    }
  }
  return { ok: true, message: "Still starting… refresh in a moment." };
}

/**
 * A log file from a byte offset (its size before this start). Not the text's character
 * index: the log has multi-byte characters (──, ✓, →), so on a long log that pointed
 * past the end, and a failed start showed no log and no reason.
 */
export function logFrom(file: string, offset: number): string {
  return readFileSync(file).subarray(offset).toString("utf8");
}

/**
 * Why a bot exited before running, from its output: its start check's problems (the "✗"
 * lines), or the error it stopped on. The website shows it as the message, since the log
 * box opens on the check's summary and the reason comes last. SoDEX not answering (still
 * failing after the client's retries) is said in plain words: the log keeps the details.
 */
export function startFailure(output: string): string | undefined {
  const lines = output.split(/\r?\n/);
  const problems = lines.filter((l) => /^\s*✗ /.test(l)).map((l) => l.replace(/^\s*✗\s*/, ""));
  const error = lines.findLast((l) => l.startsWith("Error: "))?.slice("Error: ".length);
  if (problems.length === 0 && error && UNREACHABLE.test(error)) return COULD_NOT_REACH_SODEX;
  const reason = problems.length > 0 ? problems.join("; ") : error?.trim();
  return reason ? reason[0]!.toUpperCase() + reason.slice(1) : undefined;
}

/** A bot's error when SoDEX couldn't be reached (the client's network error, or the socket's). */
const UNREACHABLE =
  /network error|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket hang up/i;
const COULD_NOT_REACH_SODEX =
  "It couldn't reach SoDEX just now (a network hiccup, nothing wrong with your bot). Try again in a moment.";

function tail(text: string, lines: number): string {
  return text.trimEnd().split(/\r?\n/).slice(-lines).join("\n");
}
