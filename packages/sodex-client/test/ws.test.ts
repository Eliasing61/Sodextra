import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SodexWsClient, type WebSocketLike } from "../src/index.ts";

type Listener = (event: { data?: unknown }) => void;

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: unknown[] = [];
  readonly listeners = new Map<string, Listener[]>();

  constructor(readonly url: string) {}

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
    this.emit("close");
  }
  emit(type: string, data?: unknown): void {
    for (const l of this.listeners.get(type) ?? []) l({ data });
  }
  open(): void {
    this.readyState = 1;
    this.emit("open");
  }
  push(message: unknown): void {
    this.emit("message", JSON.stringify(message));
  }
}

describe("SodexWsClient", () => {
  let sockets: FakeSocket[];
  const make = (extra: Partial<ConstructorParameters<typeof SodexWsClient>[0]> = {}) =>
    new SodexWsClient({
      network: "mainnet",
      engine: "perps",
      webSocketFactory: (url) => {
        const s = new FakeSocket(url);
        sockets.push(s);
        return s;
      },
      ...extra,
    });

  beforeEach(() => {
    sockets = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects to the engine URL, subscribes on open and routes pushes by channel", () => {
    const client = make();
    const marks: unknown[] = [];
    const orders: unknown[] = [];
    client.subscribe({ channel: "markPrice", symbols: ["BTC-USD"] }, (m) => marks.push(m.data));
    client.subscribe({ channel: "accountOrderUpdate", user: "0xabc" }, (m) => orders.push(m.data));
    client.connect();

    const socket = sockets[0]!;
    expect(socket.url).toBe("wss://mainnet-gw.sodex.dev/ws/perps");
    socket.open();
    expect(socket.sent).toEqual([
      { op: "subscribe", id: 1, params: { channel: "markPrice", symbols: ["BTC-USD"] } },
      { op: "subscribe", id: 2, params: { channel: "accountOrderUpdate", user: "0xabc" } },
    ]);

    socket.push({ channel: "markPrice", type: "snapshot", data: [{ s: "BTC-USD", p: "77115" }] });
    expect(marks).toEqual([[{ s: "BTC-USD", p: "77115" }]]);
    expect(orders).toEqual([]);
  });

  it("pings when idle and reconnects when no pong arrives", () => {
    const client = make({ idlePingMs: 25_000, pongTimeoutMs: 10_000 });
    client.connect();
    sockets[0]!.open();

    vi.advanceTimersByTime(25_000);
    expect(sockets[0]!.sent.at(-1)).toEqual({ op: "ping" });

    vi.advanceTimersByTime(10_000);
    expect(sockets[0]!.readyState).toBe(3);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
  });

  it("resubscribes after reconnecting and tells the caller to resync", () => {
    const onReconnected = vi.fn();
    const client = make({ onReconnected });
    client.subscribe({ channel: "accountTrade", user: "0xabc" }, () => {});
    client.connect();
    sockets[0]!.open();
    expect(onReconnected).not.toHaveBeenCalled();

    sockets[0]!.close();
    vi.advanceTimersByTime(1_000);
    const second = sockets[1]!;
    second.open();
    expect(second.sent).toEqual([
      { op: "subscribe", id: 2, params: { channel: "accountTrade", user: "0xabc" } },
    ]);
    expect(onReconnected).toHaveBeenCalledOnce();
  });

  it("reports failed subscriptions and stops for good on close()", () => {
    const onSubscribeError = vi.fn();
    const client = make({ onSubscribeError });
    const sub = client.subscribe({ channel: "nope" }, () => {});
    client.connect();
    sockets[0]!.open();
    sockets[0]!.push({
      op: "subscribe",
      success: false,
      error: "unknown channel",
      result: { channel: "nope" },
    });
    expect(onSubscribeError).toHaveBeenCalledWith({ channel: "nope" }, "unknown channel");

    sub.unsubscribe();
    expect(sockets[0]!.sent.at(-1)).toEqual({
      op: "unsubscribe",
      id: 2,
      params: { channel: "nope" },
    });

    client.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });
});
