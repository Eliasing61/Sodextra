import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

import type {
  BotEvent,
  BotRecord,
  BotStatus,
  Fill,
  RunMode,
  SessionRecord,
  TrackedOrder,
} from "../types.ts";
import { CLOSED_STATUSES } from "../types.ts";

/**
 * Durable bot state in one SQLite file (Node's built-in node:sqlite, no native
 * build). Locally this is .sodextra/sodextra.db; tests and backtests use ":memory:".
 * The server version will implement the same methods on Postgres.
 */
export class SqliteStore {
  readonly #db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.#db = new DatabaseSync(path);
    this.#db.exec(`
      PRAGMA journal_mode = WAL;
      -- WAL + NORMAL: a commit doesn't wait for the disk (bots save on every cycle; FULL
      -- made each save a disk flush). Still consistent after a crash; a power cut can lose
      -- only the last moments, which a bot rebuilds from SoDEX when it starts.
      PRAGMA synchronous = NORMAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS bots (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        strategy TEXT NOT NULL,
        symbol TEXT NOT NULL,
        market TEXT NOT NULL,
        mode TEXT NOT NULL,
        config TEXT NOT NULL,
        status TEXT NOT NULL,
        status_reason TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        owner TEXT NOT NULL DEFAULT '',
        UNIQUE (owner, name, mode)
      );
      CREATE TABLE IF NOT EXISTS bot_kv (
        bot_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (bot_id, key)
      );
      CREATE TABLE IF NOT EXISTS orders (
        bot_id TEXT NOT NULL,
        cl_ord_id TEXT NOT NULL,
        status TEXT NOT NULL,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (bot_id, cl_ord_id)
      );
      CREATE INDEX IF NOT EXISTS orders_open ON orders (bot_id, status);
      CREATE TABLE IF NOT EXISTS fills (
        bot_id TEXT NOT NULL,
        trade_id TEXT NOT NULL,
        cl_ord_id TEXT NOT NULL,
        time INTEGER NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (bot_id, trade_id)
      );
      CREATE INDEX IF NOT EXISTS fills_time ON fills (bot_id, time);
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        time INTEGER NOT NULL,
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS events_bot ON events (bot_id, id);
      CREATE TABLE IF NOT EXISTS sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        bot_id TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        ended_at INTEGER,
        end_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS sessions_bot ON sessions (bot_id, id);
      CREATE TABLE IF NOT EXISTS samples (
        bot_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        pnl REAL NOT NULL,
        data TEXT,
        PRIMARY KEY (bot_id, at)
      );
    `);
    this.#migrateOwner();
  }

  /** Databases from before multi-user: add the owner column, names unique per owner. */
  #migrateOwner(): void {
    const columns = this.#db.prepare("PRAGMA table_info(bots)").all();
    if (columns.some((c) => c.name === "owner")) return;
    this.transaction(() => {
      this.#db.exec(`
        CREATE TABLE bots_v2 (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          strategy TEXT NOT NULL,
          symbol TEXT NOT NULL,
          market TEXT NOT NULL,
          mode TEXT NOT NULL,
          config TEXT NOT NULL,
          status TEXT NOT NULL,
          status_reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          owner TEXT NOT NULL DEFAULT '',
          UNIQUE (owner, name, mode)
        );
        INSERT INTO bots_v2 (id, name, strategy, symbol, market, mode, config, status, status_reason, created_at, updated_at)
          SELECT id, name, strategy, symbol, market, mode, config, status, status_reason, created_at, updated_at FROM bots;
        DROP TABLE bots;
        ALTER TABLE bots_v2 RENAME TO bots;
      `);
    });
  }

  close(): void {
    this.#db.close();
  }

  transaction<T>(fn: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  // ── Bots ────────────────────────────────────────────────────────────────────

  createBot(bot: BotRecord): void {
    this.#run(
      `INSERT INTO bots (id, name, strategy, symbol, market, mode, config, status, status_reason, created_at, updated_at, owner)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      bot.id,
      bot.name,
      bot.strategy,
      bot.symbol,
      bot.market,
      bot.mode,
      JSON.stringify(bot.config),
      bot.status,
      bot.statusReason ?? null,
      bot.createdAt,
      bot.updatedAt,
      bot.owner?.toLowerCase() ?? "",
    );
  }

  getBot(id: string): BotRecord | undefined {
    const row = this.#db.prepare("SELECT * FROM bots WHERE id = ?").get(id);
    return row ? toBot(row) : undefined;
  }

  /** A bot by name; owner unset = the server's own account. */
  findBot(name: string, mode: RunMode, owner?: string): BotRecord | undefined {
    const row = this.#db
      .prepare("SELECT * FROM bots WHERE name = ? AND mode = ? AND owner = ?")
      .get(name, mode, owner?.toLowerCase() ?? "");
    return row ? toBot(row) : undefined;
  }

  listBots(): BotRecord[] {
    return this.#db.prepare("SELECT * FROM bots ORDER BY created_at").all().map(toBot);
  }

  updateBotConfig(id: string, config: unknown, now: number): void {
    this.#run(
      "UPDATE bots SET config = ?, updated_at = ? WHERE id = ?",
      JSON.stringify(config),
      now,
      id,
    );
  }

  setBotStatus(id: string, status: BotStatus, reason: string | undefined, now: number): void {
    this.#run(
      "UPDATE bots SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?",
      status,
      reason ?? null,
      now,
      id,
    );
  }

  deleteBot(id: string): void {
    this.transaction(() => {
      for (const table of ["bot_kv", "orders", "fills", "events", "sessions", "samples"]) {
        this.#run(`DELETE FROM ${table} WHERE bot_id = ?`, id);
      }
      this.#run("DELETE FROM bots WHERE id = ?", id);
    });
  }

  // ── Key/value (strategy state, engine state, paper account) ────────────────

  getKV<T>(botId: string, key: string): T | undefined {
    const row = this.#db
      .prepare("SELECT value FROM bot_kv WHERE bot_id = ? AND key = ?")
      .get(botId, key);
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }

  /** setKV for a value that is already JSON. */
  setKVJson(botId: string, key: string, json: string): void {
    this.#run(
      `INSERT INTO bot_kv (bot_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT (bot_id, key) DO UPDATE SET value = excluded.value`,
      botId,
      key,
      json,
    );
  }

  setKV(botId: string, key: string, value: unknown): void {
    this.#run(
      `INSERT INTO bot_kv (bot_id, key, value) VALUES (?, ?, ?)
       ON CONFLICT (bot_id, key) DO UPDATE SET value = excluded.value`,
      botId,
      key,
      JSON.stringify(value),
    );
  }

  // ── Orders ──────────────────────────────────────────────────────────────────

  saveOrder(botId: string, order: TrackedOrder): void {
    this.#run(
      `INSERT INTO orders (bot_id, cl_ord_id, status, data, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (bot_id, cl_ord_id) DO UPDATE SET status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`,
      botId,
      order.clOrdID,
      order.status,
      JSON.stringify(order),
      order.updatedAt,
    );
  }

  getOrder(botId: string, clOrdID: string): TrackedOrder | undefined {
    const row = this.#db
      .prepare("SELECT data FROM orders WHERE bot_id = ? AND cl_ord_id = ?")
      .get(botId, clOrdID);
    return row ? (JSON.parse(String(row.data)) as TrackedOrder) : undefined;
  }

  /** Orders that are not in a final state (open, pending, cancelling, unknown, ...). */
  activeOrders(botId: string): TrackedOrder[] {
    const closed = [...CLOSED_STATUSES];
    return this.#db
      .prepare(
        `SELECT data FROM orders WHERE bot_id = ? AND status NOT IN (${closed.map(() => "?").join(",")}) ORDER BY updated_at`,
      )
      .all(botId, ...closed)
      .map((r) => JSON.parse(String(r.data)) as TrackedOrder);
  }

  recentOrders(botId: string, limit = 50): TrackedOrder[] {
    return this.#db
      .prepare("SELECT data FROM orders WHERE bot_id = ? ORDER BY updated_at DESC LIMIT ?")
      .all(botId, limit)
      .map((r) => JSON.parse(String(r.data)) as TrackedOrder);
  }

  // ── Fills ───────────────────────────────────────────────────────────────────

  /** Returns false when the fill was already recorded (seen via another channel). */
  addFill(botId: string, fill: Fill): boolean {
    const result = this.#db
      .prepare(
        "INSERT OR IGNORE INTO fills (bot_id, trade_id, cl_ord_id, time, data) VALUES (?, ?, ?, ?, ?)",
      )
      .run(botId, fill.tradeId, fill.clOrdID, fill.time, JSON.stringify(fill));
    return Number(result.changes) > 0;
  }

  getFill(botId: string, tradeId: string): Fill | undefined {
    const row = this.#db
      .prepare("SELECT data FROM fills WHERE bot_id = ? AND trade_id = ?")
      .get(botId, tradeId);
    return row ? (JSON.parse(String(row.data)) as Fill) : undefined;
  }

  /** Replace a stored fill's details (e.g. the fee coin, known only from REST). */
  updateFill(botId: string, fill: Fill): void {
    this.#db
      .prepare("UPDATE fills SET data = ? WHERE bot_id = ? AND trade_id = ?")
      .run(JSON.stringify(fill), botId, fill.tradeId);
  }

  hasFill(botId: string, tradeId: string): boolean {
    return (
      this.#db
        .prepare("SELECT 1 FROM fills WHERE bot_id = ? AND trade_id = ?")
        .get(botId, tradeId) !== undefined
    );
  }

  listFills(botId: string, options: { limit?: number } = {}): Fill[] {
    return this.#db
      .prepare("SELECT data FROM fills WHERE bot_id = ? ORDER BY time DESC, trade_id DESC LIMIT ?")
      .all(botId, options.limit ?? 1_000_000)
      .map((r) => JSON.parse(String(r.data)) as Fill);
  }

  /** How many fills a bot has and the newest one's time (cheap: for change checks). */
  fillStats(botId: string): { count: number; last: number | undefined } {
    const row = this.#db
      .prepare("SELECT COUNT(*) AS n, MAX(time) AS t FROM fills WHERE bot_id = ?")
      .get(botId);
    return {
      count: Number(row?.n ?? 0),
      last: row?.t === null || row?.t === undefined ? undefined : Number(row.t),
    };
  }

  /** Fills at or after a time, oldest first. */
  listFillsFrom(botId: string, from: number): Fill[] {
    return this.#db
      .prepare(
        "SELECT data FROM fills WHERE bot_id = ? AND time >= ? ORDER BY time ASC, trade_id ASC",
      )
      .all(botId, from)
      .map((r) => JSON.parse(String(r.data)) as Fill);
  }

  lastFillTime(botId: string): number | undefined {
    const row = this.#db.prepare("SELECT MAX(time) AS t FROM fills WHERE bot_id = ?").get(botId);
    return row?.t === null || row?.t === undefined ? undefined : Number(row.t);
  }

  // ── Samples (the bot's PnL over time, one a minute, for charts) ──────────────

  /** The bot's total PnL at `at` (a minute), plus strategy numbers (e.g. grid profit). */
  addSample(botId: string, at: number, pnl: number, data?: Record<string, number>): void {
    this.#run(
      "INSERT OR REPLACE INTO samples (bot_id, at, pnl, data) VALUES (?, ?, ?, ?)",
      botId,
      at,
      pnl,
      data ? JSON.stringify(data) : null,
    );
  }

  /** Samples at or after a time, oldest first. */
  listSamples(
    botId: string,
    from: number,
  ): { at: number; pnl: number; data: Record<string, number> }[] {
    return this.#db
      .prepare("SELECT at, pnl, data FROM samples WHERE bot_id = ? AND at >= ? ORDER BY at ASC")
      .all(botId, from)
      .map((r) => ({
        at: Number(r.at),
        pnl: Number(r.pnl),
        data: r.data ? (JSON.parse(String(r.data)) as Record<string, number>) : {},
      }));
  }

  /** Before `before`, keep one sample an hour (the one on the hour). */
  thinSamples(botId: string, before: number): void {
    this.#run(
      "DELETE FROM samples WHERE bot_id = ? AND at < ? AND at % 3600000 != 0",
      botId,
      before,
    );
  }

  // ── Events ──────────────────────────────────────────────────────────────────

  addEvent(botId: string, event: BotEvent): void {
    this.#run(
      "INSERT INTO events (bot_id, time, level, type, message, data) VALUES (?, ?, ?, ?, ?, ?)",
      botId,
      event.time,
      event.level,
      event.type,
      event.message,
      event.data === undefined ? null : JSON.stringify(event.data),
    );
  }

  recentEvents(botId: string, limit = 20): BotEvent[] {
    return this.#db
      .prepare("SELECT * FROM events WHERE bot_id = ? ORDER BY id DESC LIMIT ?")
      .all(botId, limit)
      .map((r) => ({
        time: Number(r.time),
        level: String(r.level) as BotEvent["level"],
        type: String(r.type),
        message: String(r.message),
        ...(r.data === null ? {} : { data: JSON.parse(String(r.data)) as unknown }),
      }));
  }

  /** When a bot logged events of one type (e.g. "new-run"), oldest first. */
  eventTimes(botId: string, type: string): number[] {
    return this.#db
      .prepare("SELECT time FROM events WHERE bot_id = ? AND type = ? ORDER BY time ASC")
      .all(botId, type)
      .map((r) => Number(r.time));
  }

  // ── Sessions ────────────────────────────────────────────────────────────────

  startSession(botId: string, at: number): number {
    const result = this.#db
      .prepare("INSERT INTO sessions (bot_id, started_at) VALUES (?, ?)")
      .run(botId, at);
    return Number(result.lastInsertRowid);
  }

  /** Removes a run that never got going (its start failed). */
  dropSession(id: number): void {
    this.#run("DELETE FROM sessions WHERE id = ?", id);
  }

  endSession(id: number, at: number, reason: string): void {
    this.#run(
      "UPDATE sessions SET ended_at = ?, end_reason = ? WHERE id = ? AND ended_at IS NULL",
      at,
      reason,
      id,
    );
  }

  /** Newest first; all bots when botId is omitted. */
  listSessions(botId?: string, limit = 200): SessionRecord[] {
    const rows =
      botId === undefined
        ? this.#db.prepare("SELECT * FROM sessions ORDER BY id DESC LIMIT ?").all(limit)
        : this.#db
            .prepare("SELECT * FROM sessions WHERE bot_id = ? ORDER BY id DESC LIMIT ?")
            .all(botId, limit);
    return rows.map((r) => ({
      id: Number(r.id),
      botId: String(r.bot_id),
      startedAt: Number(r.started_at),
      endedAt: r.ended_at === null ? undefined : Number(r.ended_at),
      endReason: r.end_reason === null ? undefined : String(r.end_reason),
    }));
  }

  #run(sql: string, ...params: SQLInputValue[]): void {
    this.#db.prepare(sql).run(...params);
  }
}

function toBot(row: Record<string, unknown>): BotRecord {
  return {
    id: String(row.id),
    name: String(row.name),
    strategy: String(row.strategy),
    symbol: String(row.symbol),
    market: String(row.market) as BotRecord["market"],
    mode: String(row.mode) as BotRecord["mode"],
    config: JSON.parse(String(row.config)) as unknown,
    status: String(row.status) as BotStatus,
    statusReason: row.status_reason === null ? undefined : String(row.status_reason),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    ...(row.owner ? { owner: String(row.owner) } : {}),
  };
}
