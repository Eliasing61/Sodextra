import { resolveNetwork, type Engine, type Network, type NetworkConfig } from "../config.ts";
import { parseJson } from "../json.ts";

/** Subscription params exactly as SoDEX expects them, e.g. {channel: "markPrice", symbols: ["BTC-USD"]}. */
export type WsParams = { channel: string } & Record<string, unknown>;

export interface WsPush<T = unknown> {
  channel: string;
  /** "snapshot" on (re)subscribe, then "update". */
  type: "snapshot" | "update" | string;
  data: T;
}

export type WsHandler<T = unknown> = (message: WsPush<T>) => void;

export interface Subscription {
  readonly params: WsParams;
  unsubscribe(): void;
}

/** Minimal WebSocket surface we use; Node 22+ and browsers provide it globally. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: "open" | "close" | "error" | "message",
    listener: (event: { data?: unknown }) => void,
  ): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface SodexWsOptions {
  network: Network | NetworkConfig;
  engine: Engine;
  /** Send a ping after this long without any message (server drops at 60 s). */
  idlePingMs?: number;
  /** Reconnect if nothing arrives this long after a ping. */
  pongTimeoutMs?: number;
  maxBackoffMs?: number;
  webSocketFactory?: WebSocketFactory;
  /** Called after every successful reconnect: take a REST snapshot, streams don't replay missed events. */
  onReconnected?: () => void;
  onError?: (error: unknown) => void;
  /** Subscription acknowledgements with success=false. */
  onSubscribeError?: (params: WsParams, error: string) => void;
}

const OPEN = 1;

interface Entry {
  params: WsParams;
  handler: WsHandler;
}

/**
 * One connection to one engine's stream. Keeps the connection alive with
 * pings, reconnects with exponential backoff, and re-sends every active
 * subscription after reconnecting.
 *
 * Pushes are routed by channel. Each connection should carry one user's
 * account channels (the bot use case); market channels can be mixed freely.
 */
export class SodexWsClient {
  readonly url: string;
  readonly #options: Required<
    Pick<SodexWsOptions, "idlePingMs" | "pongTimeoutMs" | "maxBackoffMs">
  > &
    SodexWsOptions;
  readonly #factory: WebSocketFactory;
  readonly #entries = new Set<Entry>();
  #socket: WebSocketLike | undefined;
  #idleTimer: ReturnType<typeof setTimeout> | undefined;
  #pongTimer: ReturnType<typeof setTimeout> | undefined;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #attempt = 0;
  #requestId = 0;
  #closed = true;
  #everConnected = false;

  constructor(options: SodexWsOptions) {
    const network = resolveNetwork(options.network);
    this.url = `${network.wsBaseUrl}/ws/${options.engine}`;
    this.#options = { idlePingMs: 25_000, pongTimeoutMs: 10_000, maxBackoffMs: 30_000, ...options };
    this.#factory =
      options.webSocketFactory ??
      ((url) => new globalThis.WebSocket(url) as unknown as WebSocketLike);
  }

  get connected(): boolean {
    return this.#socket?.readyState === OPEN;
  }

  connect(): void {
    if (!this.#closed) return;
    this.#closed = false;
    this.#open();
  }

  /**
   * Drop the current connection and open a new one right away, without waiting for
   * the old one to close (on a broken network that can take a minute). Every
   * subscription is re-sent and onReconnected fires once the new one is open.
   */
  reconnect(): void {
    if (this.#closed) return;
    const old = this.#socket;
    this.#socket = undefined;
    this.#clearTimers();
    clearTimeout(this.#reconnectTimer);
    try {
      old?.close(4001, "reconnecting");
    } catch {
      // already broken
    }
    this.#attempt = 0;
    this.#open();
  }

  close(): void {
    this.#closed = true;
    this.#clearTimers();
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close(1000, "client closed");
    this.#socket = undefined;
  }

  subscribe<T = unknown>(params: WsParams, handler: WsHandler<T>): Subscription {
    const entry: Entry = { params, handler: handler as WsHandler };
    this.#entries.add(entry);
    if (this.connected) this.#send({ op: "subscribe", id: ++this.#requestId, params });
    return {
      params,
      unsubscribe: () => {
        if (!this.#entries.delete(entry)) return;
        if (this.connected) this.#send({ op: "unsubscribe", id: ++this.#requestId, params });
      },
    };
  }

  #open(): void {
    let socket: WebSocketLike;
    try {
      socket = this.#factory(this.url);
    } catch (error) {
      this.#options.onError?.(error);
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;

    socket.addEventListener("open", () => {
      if (socket !== this.#socket) return;
      const isReconnect = this.#everConnected;
      this.#everConnected = true;
      this.#attempt = 0;
      for (const entry of this.#entries)
        this.#send({ op: "subscribe", id: ++this.#requestId, params: entry.params });
      this.#armIdle();
      if (isReconnect) this.#options.onReconnected?.();
    });

    socket.addEventListener("message", (event) => {
      if (socket !== this.#socket) return;
      this.#armIdle();
      this.#handleMessage(event.data);
    });

    socket.addEventListener("error", (event) => {
      if (socket !== this.#socket) return;
      this.#options.onError?.(event);
    });

    socket.addEventListener("close", () => {
      if (socket !== this.#socket) return;
      this.#socket = undefined;
      this.#clearTimers();
      if (!this.#closed) this.#scheduleReconnect();
    });
  }

  #handleMessage(raw: unknown): void {
    let message: Record<string, unknown>;
    try {
      message = parseJson(typeof raw === "string" ? raw : String(raw)) as Record<string, unknown>;
    } catch (error) {
      this.#options.onError?.(error);
      return;
    }

    if (message.op === "pong") return;
    if (message.op === "error") {
      this.#options.onError?.(new Error(String(message.error)));
      return;
    }
    if (message.op === "subscribe" || message.op === "unsubscribe") {
      if (message.success === false) {
        const params = (message.params ?? message.result ?? {}) as WsParams;
        this.#options.onSubscribeError?.(params, String(message.error ?? "subscription failed"));
      }
      return;
    }

    if (typeof message.channel === "string") {
      const push = message as unknown as WsPush;
      for (const entry of this.#entries) {
        if (entry.params.channel === push.channel) {
          try {
            entry.handler(push);
          } catch (error) {
            this.#options.onError?.(error);
          }
        }
      }
    }
  }

  #send(payload: unknown): void {
    try {
      this.#socket?.send(JSON.stringify(payload));
    } catch (error) {
      this.#options.onError?.(error);
    }
  }

  #armIdle(): void {
    this.#clearTimers();
    this.#idleTimer = setTimeout(() => {
      this.#send({ op: "ping" });
      this.#pongTimer = setTimeout(() => {
        // No reply at all: treat the connection as dead.
        this.#socket?.close(4000, "pong timeout");
      }, this.#options.pongTimeoutMs);
    }, this.#options.idlePingMs);
  }

  #clearTimers(): void {
    clearTimeout(this.#idleTimer);
    clearTimeout(this.#pongTimer);
  }

  #scheduleReconnect(): void {
    if (this.#closed) return;
    const base = Math.min(1000 * 2 ** this.#attempt, this.#options.maxBackoffMs);
    this.#attempt += 1;
    const delay = base / 2 + Math.random() * (base / 2);
    this.#reconnectTimer = setTimeout(() => this.#open(), delay);
  }
}
