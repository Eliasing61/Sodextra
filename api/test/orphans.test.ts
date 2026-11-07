import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { listProcesses, lockedPids, orphanBots, type ProcInfo } from "../src/orphans.ts";

const CLI = "/opt/sodextra/apps/cli/src/main.ts";
const run = (pid: number, mode = "live"): ProcInfo => ({
  pid,
  ppid: 1,
  args: ["/usr/bin/node", "--import", "file:///tsx/loader.mjs", CLI, mode, "/bots/a.json"],
});

describe("orphan bot processes", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("finds bot runs that hold no lock, and nothing else", () => {
    const processes: ProcInfo[] = [
      run(100), // holds its lock
      run(200), // the stuck one
      run(300, "paper"),
      { pid: 400, ppid: 1, args: ["/usr/bin/node", "--import", "tsx", "apps/api/src/main.ts"] },
      { pid: 500, ppid: 1, args: ["/usr/bin/node", CLI, "stop", "/bots/a.json"] },
      { pid: 600, ppid: 200, args: ["/esbuild", "--service"] },
    ];
    expect(orphanBots(processes, new Set([100])).map((p) => p.pid)).toEqual([200, 300]);
  });

  it("reads processes and lock files from disk", () => {
    const proc = mkdtempSync(join(tmpdir(), "proc-"));
    const locks = mkdtempSync(join(tmpdir(), "locks-"));
    dirs.push(proc, locks);
    mkdirSync(join(proc, "62110"));
    writeFileSync(join(proc, "62110", "cmdline"), `/usr/bin/node\0${CLI}\0live\0/bots/a.json\0`);
    writeFileSync(join(proc, "62110", "stat"), "62110 (Main Thread) R 1 62110 62110 0 -1");
    mkdirSync(join(proc, "self"));
    writeFileSync(join(locks, "abc.pid"), "81658");
    expect(listProcesses(proc)).toEqual([
      { pid: 62110, ppid: 1, args: ["/usr/bin/node", CLI, "live", "/bots/a.json"] },
    ]);
    expect([...lockedPids(locks)]).toEqual([81658]);
    expect(listProcesses(join(proc, "missing"))).toEqual([]);
  });
});
