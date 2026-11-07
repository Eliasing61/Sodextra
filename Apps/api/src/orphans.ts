import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Bot processes left running without their bot: a run that ended (its lock released) but
 * whose process never exited. Seen once on the server: one spun a full CPU core for two
 * days. Linux only (reads /proc); elsewhere nothing is found.
 */

export interface ProcInfo {
  pid: number;
  ppid: number;
  args: string[];
}

/** Every process readable in `procDir`; empty when there is no /proc. */
export function listProcesses(procDir = "/proc"): ProcInfo[] {
  let entries: string[];
  try {
    entries = readdirSync(procDir);
  } catch {
    return [];
  }
  const out: ProcInfo[] = [];
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = readFileSync(join(procDir, entry, "cmdline"), "utf8")
        .split("\0")
        .filter(Boolean);
      // "pid (name) state ppid ...": the name can hold spaces, so read after its ")".
      const stat = readFileSync(join(procDir, entry, "stat"), "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      out.push({ pid: Number(entry), ppid, args });
    } catch {
      // Gone already, or not readable.
    }
  }
  return out;
}

/** Bot runs (`…/apps/cli/src/main.ts live|paper <file>`) whose process holds no bot lock. */
export function orphanBots(processes: ProcInfo[], lockedPids: Set<number>): ProcInfo[] {
  return processes.filter((p) => {
    const i = p.args.findIndex((a) => /apps[\\/]cli[\\/]src[\\/]main\.ts$/.test(a));
    const run = p.args[i + 1];
    return i >= 0 && (run === "live" || run === "paper") && !lockedPids.has(p.pid);
  });
}

/** Pids written in the bots' lock files. */
export function lockedPids(lockDir: string): Set<number> {
  try {
    return new Set(
      readdirSync(lockDir)
        .filter((f) => f.endsWith(".pid"))
        .map((f) => Number(readFileSync(join(lockDir, f), "utf8")))
        .filter(Number.isInteger),
    );
  } catch {
    return new Set();
  }
}
