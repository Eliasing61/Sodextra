import {
  canonicalDecimal,
  toDecimal,
  type MarketSymbol,
  type SpotSymbol,
} from "@sodextra/sodex-client";

import { applyFill, emptyPosition, unrealizedPnl, type PositionState } from "../position.ts";
import type {
  AccountEvent,
  AccountSnapshot,
  ActionResult,
  ExchangeOrder,
  Fill,
  MarketKind,
  PlaceRequest,
  ReplaceRequest,
  Side,
} from "../types.ts";

export interface SimOptions {
  symbol: MarketSymbol;
  market: MarketKind;
  makerFee: string;
  takerFee: string;
  /** Starting quote balance (USDC). */
  quoteBalance: string;
  /** Spot only: starting base balance. */
  baseBalance?: string;
  now: () => number;
  emit: (event: AccountEvent) => void;
  /**
   * Model queue position at the best price (needs book sizes and trade sizes, so
   * paper only). Without it, resting orders fill only when trades go through them.
   */
  queueModel?: boolean;
}

interface SimOrder extends ExchangeOrder {
  clOrdID: string;
  timeInForce: PlaceRequest["timeInForce"];
  stopType?: "STOP_LOSS" | "TAKE_PROFIT" | undefined;
  /** Size resting ahead of us at our price (queue model); undefined = not known yet. */
  queueAhead?: string | undefined;
}

export interface SimState {
  orders: SimOrder[];
  position: PositionState;
  quote: string;
  base: string;
  fills: Fill[];
  nextId: number;
}

/**
 * A small, deterministic matching simulator for one symbol. Conservative by design:
 * - resting limit orders fill fully when the market trades *through* their price
 *   (a buy at 100 fills when a trade prints below 100);
 * - with the queue model on (paper), an order AT the best price fills only after the
 *   size that was queued ahead of it has traded, partially if needed;
 * - post-only orders that would cross are expired, like GTX on SoDEX;
 * - stops trigger on the mark price and execute at the opposite best price;
 * - fees are charged in quote at the configured maker/taker rates.
 * Liquidity is assumed sufficient; slippage beyond the touch is not modelled.
 */
export class SimCore {
  readonly #o: SimOptions;
  #state: SimState;
  #bid: string | undefined;
  #ask: string | undefined;
  #bidSize: string | undefined;
  #askSize: string | undefined;
  #mark: string | undefined;

  constructor(options: SimOptions, restore?: SimState) {
    this.#o = options;
    this.#state = restore ?? {
      orders: [],
      position: emptyPosition(),
      quote: options.quoteBalance,
      base: options.baseBalance ?? "0",
      fills: [],
      nextId: 1,
    };
  }

  get state(): SimState {
    return this.#state;
  }

  get mark(): string | undefined {
    return this.#mark;
  }

  // ── Market input ────────────────────────────────────────────────────────────

  setBook(bid: string, ask: string, bidSize?: string, askSize?: string): void {
    this.#bid = bid;
    this.#ask = ask;
    this.#bidSize = bidSize;
    this.#askSize = askSize;
    if (!this.#o.queueModel) return;
    // An order whose price just became the best learns its queue: assume everything
    // already showing at that price is ahead of it (conservative).
    for (const order of this.#state.orders) {
      if (order.kind !== "limit" || order.queueAhead !== undefined) continue;
      if (order.side === "BUY" && bidSize !== undefined && toDecimal(order.price!).eq(bid))
        order.queueAhead = bidSize;
      if (order.side === "SELL" && askSize !== undefined && toDecimal(order.price!).eq(ask))
        order.queueAhead = askSize;
    }
  }

  setMark(price: string): void {
    this.#mark = price;
    this.#triggerStops();
  }

  /**
   * A market trade printed at `price`. Orders it traded through fill fully. With the
   * queue model, a trade AT an order's price whose aggressor hit that side eats the
   * queue ahead first, then fills the order (partially if the trade was small).
   */
  onTrade(price: string, quantity?: string, aggressor?: Side): void {
    const p = toDecimal(price);
    for (const order of [...this.#state.orders]) {
      if (order.kind !== "limit") continue;
      const limit = toDecimal(order.price!);
      const through = order.side === "BUY" ? p.lt(limit) : p.gt(limit);
      if (through) {
        this.#execute(order, order.price!, true);
        continue;
      }
      const hitsOurSide = aggressor !== undefined && aggressor !== order.side;
      if (!this.#o.queueModel || quantity === undefined || !hitsOurSide || !p.eq(limit)) continue;
      if (order.queueAhead === undefined) continue;
      const ahead = toDecimal(order.queueAhead).minus(quantity);
      if (ahead.gte(0)) {
        order.queueAhead = canonicalDecimal(ahead);
        continue;
      }
      order.queueAhead = "0";
      this.#execute(order, order.price!, true, canonicalDecimal(ahead.neg()));
    }
  }

  /** Backtests: walk a price path, updating book, mark and trades at each point. */
  walk(price: string): void {
    const tick = toDecimal(this.#o.symbol.tickSize);
    const p = toDecimal(price);
    this.setBook(canonicalDecimal(p.minus(tick)), canonicalDecimal(p.plus(tick)));
    this.setMark(price);
    this.onTrade(price);
  }

  // ── Orders ──────────────────────────────────────────────────────────────────

  place(requests: PlaceRequest[]): ActionResult[] {
    return requests.map((req) => this.#placeOne(req));
  }

  cancel(clOrdIDs: string[]): ActionResult[] {
    return clOrdIDs.map((clOrdID) => {
      const order = this.#state.orders.find((o) => o.clOrdID === clOrdID);
      if (!order) return { clOrdID, ok: false, error: "order not found" };
      this.#remove(order);
      order.status = "canceled";
      this.#emitOrder(order);
      return { clOrdID, ok: true, orderId: order.orderId };
    });
  }

  /** Atomic replace: the old order goes, a new one with the same type takes its place. */
  replace(requests: ReplaceRequest[]): ActionResult[] {
    return requests.map((req) => {
      const old = this.#state.orders.find((o) => o.clOrdID === req.origClOrdID);
      if (
        !old ||
        old.kind !== "limit" ||
        old.timeInForce === "IOC" ||
        !toDecimal(old.filledQty).isZero()
      ) {
        return { clOrdID: req.clOrdID, ok: false, error: "order not found or not replaceable" };
      }
      this.#remove(old);
      old.status = "canceled";
      this.#emitOrder(old, `replaced by ${req.clOrdID}`);
      return this.#placeOne({
        clOrdID: req.clOrdID,
        side: old.side,
        kind: "limit",
        price: req.price ?? old.price,
        quantity: req.quantity ?? old.quantity,
        timeInForce: old.timeInForce,
        reduceOnly: old.reduceOnly,
      });
    });
  }

  snapshot(): AccountSnapshot {
    return {
      time: this.#o.now(),
      openOrders: this.#state.orders.map((o) => ({ ...o })),
      position: {
        size: this.#o.market === "spot" ? this.#state.base : this.#state.position.size,
        entryPrice: this.#state.position.avgEntry,
        unrealizedPnl: unrealizedPnl(this.#state.position, this.#mark),
      },
      availableQuote: this.#state.quote,
    };
  }

  fillsSince(since: number): Fill[] {
    return this.#state.fills.filter((f) => f.time >= since);
  }

  findOrder(clOrdID: string): ExchangeOrder | undefined {
    return this.#state.orders.find((o) => o.clOrdID === clOrdID);
  }

  #placeOne(req: PlaceRequest): ActionResult {
    const reject = (error: string): ActionResult => ({ clOrdID: req.clOrdID, ok: false, error });
    if (this.#state.orders.some((o) => o.clOrdID === req.clOrdID))
      return reject("duplicate clOrdID");
    if (req.kind === "stop" && this.#o.market === "spot")
      return reject("stop orders are perps only");

    const order: SimOrder = {
      clOrdID: req.clOrdID,
      orderId: String(this.#state.nextId++),
      side: req.side,
      kind: req.kind,
      price: req.price,
      quantity: req.quantity,
      filledQty: "0",
      status: "open",
      reduceOnly: req.reduceOnly,
      stopPrice: req.stopPrice,
      stopType: req.stopType,
      timeInForce: req.timeInForce,
    };

    if (req.kind === "stop") {
      if (!req.stopPrice) return reject("stop needs stopPrice");
      this.#state.orders.push(order);
      this.#emitOrder(order);
      return { clOrdID: req.clOrdID, ok: true, orderId: order.orderId };
    }

    const touch = req.side === "BUY" ? this.#ask : this.#bid;
    if (touch === undefined) return reject("no market data");
    if (!req.quantity) return reject("quantity required");

    if (req.kind === "market") {
      const result = this.#execute(order, touch, false);
      return result ?? { clOrdID: req.clOrdID, ok: true, orderId: order.orderId };
    }

    const crosses =
      req.side === "BUY" ? toDecimal(req.price!).gte(touch) : toDecimal(req.price!).lte(touch);
    if (crosses && req.timeInForce === "GTX") {
      order.status = "expired";
      this.#emitOrder(order, "post-only order would cross");
      return { clOrdID: req.clOrdID, ok: true, orderId: order.orderId };
    }
    if (crosses) {
      const price = req.side === "BUY" ? decMin(req.price!, touch) : decMax(req.price!, touch);
      const result = this.#execute(order, price, false);
      return result ?? { clOrdID: req.clOrdID, ok: true, orderId: order.orderId };
    }
    if (req.timeInForce === "IOC") {
      order.status = "expired";
      this.#emitOrder(order, "IOC not filled");
      return { clOrdID: req.clOrdID, ok: true, orderId: order.orderId };
    }
    if (this.#o.market === "spot") {
      const problem = this.#spotFunds(order, req.price!);
      if (problem) return reject(problem);
    }
    if (this.#o.queueModel) order.queueAhead = this.#queueOnJoin(req.side, req.price!);
    this.#state.orders.push(order);
    this.#emitOrder(order);
    return { clOrdID: req.clOrdID, ok: true, orderId: order.orderId };
  }

  /** Queue ahead of a new resting order: 0 inside the spread, the shown size at the best price, unknown behind it. */
  #queueOnJoin(side: Side, price: string): string | undefined {
    const best = side === "BUY" ? this.#bid : this.#ask;
    const size = side === "BUY" ? this.#bidSize : this.#askSize;
    if (best === undefined) return undefined;
    const p = toDecimal(price);
    const better = side === "BUY" ? p.gt(best) : p.lt(best);
    if (better) return "0";
    return p.eq(best) ? size : undefined;
  }

  /**
   * Fill `upTo` (default: everything left) at `price`. Returns an error result when
   * the fill is impossible. A partly filled limit order stays on the book.
   */
  #execute(
    order: SimOrder,
    price: string,
    maker: boolean,
    upTo?: string,
  ): ActionResult | undefined {
    const remaining = toDecimal(order.quantity ?? this.#positionSizeAbs()).minus(order.filledQty);
    let qty = upTo !== undefined && toDecimal(upTo).lt(remaining) ? toDecimal(upTo) : remaining;
    qty = toDecimal(roundDown(qty, this.#o.symbol.stepSize));
    if (qty.lte(0)) return undefined;
    if (order.reduceOnly) {
      const pos = toDecimal(this.#state.position.size);
      const reducible = (order.side === "SELL" && pos.gt(0)) || (order.side === "BUY" && pos.lt(0));
      if (!reducible) {
        this.#remove(order);
        order.status = "expired";
        this.#emitOrder(order, "reduce-only with nothing to reduce");
        return {
          clOrdID: order.clOrdID,
          ok: false,
          error: "reduce-only order would not reduce position",
        };
      }
      if (qty.gt(pos.abs())) qty = pos.abs();
    }
    if (this.#o.market === "spot") {
      const problem = this.#spotFunds({ ...order, quantity: canonicalDecimal(qty) }, price);
      if (problem) {
        this.#remove(order);
        order.status = "rejected";
        this.#emitOrder(order, problem);
        return { clOrdID: order.clOrdID, ok: false, error: problem };
      }
    }

    const notional = qty.mul(price);
    const rate = maker ? this.#o.makerFee : this.#o.takerFee;
    // As on SoDEX: a spot buy pays its fee in the coin it receives, everything else in USDC.
    const baseCoin =
      this.#o.market === "spot" ? (this.#o.symbol as SpotSymbol).baseCoin : undefined;
    const feeInCoin = baseCoin !== undefined && order.side === "BUY";
    const fee = feeInCoin ? qty.mul(rate) : notional.mul(rate);
    const fill: Fill = {
      tradeId: `sim-${this.#state.nextId++}`,
      clOrdID: order.clOrdID,
      orderId: order.orderId,
      side: order.side,
      price: canonicalDecimal(price),
      quantity: canonicalDecimal(qty),
      fee: canonicalDecimal(fee),
      feeCoin: feeInCoin ? baseCoin : "vUSDC",
      isMaker: maker,
      time: this.#o.now(),
    };

    const before = toDecimal(this.#state.position.realizedPnl);
    this.#state.position = applyFill(this.#state.position, fill, baseCoin);
    if (this.#o.market === "spot") {
      const sign = order.side === "BUY" ? 1 : -1;
      const got = feeInCoin ? qty.minus(fee) : qty;
      this.#state.base = canonicalDecimal(toDecimal(this.#state.base).plus(got.mul(sign)));
      this.#state.quote = canonicalDecimal(
        toDecimal(this.#state.quote)
          .minus(notional.mul(sign))
          .minus(feeInCoin ? 0 : fee),
      );
    } else {
      const realized = toDecimal(this.#state.position.realizedPnl).minus(before);
      this.#state.quote = canonicalDecimal(toDecimal(this.#state.quote).plus(realized).minus(fee));
    }
    this.#state.fills.push(fill);
    if (this.#state.fills.length > 5_000) this.#state.fills.splice(0, 1_000);

    order.filledQty = canonicalDecimal(toDecimal(order.filledQty).plus(qty));
    const done = order.quantity === undefined || toDecimal(order.filledQty).gte(order.quantity);
    order.status = done ? "filled" : "partially_filled";
    if (done) this.#remove(order);
    this.#o.emit({ type: "fill", fill });
    this.#emitOrder(order);
    return undefined;
  }

  #triggerStops(): void {
    if (this.#mark === undefined) return;
    const mark = toDecimal(this.#mark);
    for (const order of [...this.#state.orders]) {
      if (order.kind !== "stop") continue;
      const stop = toDecimal(order.stopPrice!);
      // STOP_LOSS: sell when price falls to the stop, buy when it rises to it. TAKE_PROFIT: the reverse.
      const fallingTrigger = (order.side === "SELL") === (order.stopType !== "TAKE_PROFIT");
      const hit = fallingTrigger ? mark.lte(stop) : mark.gte(stop);
      if (!hit) continue;
      const touch = order.side === "BUY" ? this.#ask : this.#bid;
      this.#execute(order, touch ?? this.#mark, false);
    }
  }

  #spotFunds(order: Pick<SimOrder, "side" | "quantity">, price: string): string | undefined {
    const qty = toDecimal(order.quantity ?? "0");
    const reserved = (side: "BUY" | "SELL") =>
      this.#state.orders
        .filter((o) => o.side === side && o.kind === "limit")
        .reduce(
          (sum, o) =>
            sum.plus(
              side === "BUY"
                ? toDecimal(o.price!).mul(toDecimal(o.quantity!).minus(o.filledQty))
                : toDecimal(o.quantity!).minus(o.filledQty),
            ),
          toDecimal(0),
        );
    if (order.side === "BUY") {
      const need = qty.mul(price).mul(toDecimal(1).plus(this.#o.takerFee));
      if (need.plus(reserved("BUY")).gt(this.#state.quote)) return "insufficient quote balance";
    } else if (qty.plus(reserved("SELL")).gt(this.#state.base)) {
      return "insufficient base balance";
    }
    return undefined;
  }

  #positionSizeAbs(): string {
    return canonicalDecimal(toDecimal(this.#state.position.size).abs());
  }

  #remove(order: SimOrder): void {
    this.#state.orders = this.#state.orders.filter((o) => o !== order);
  }

  #emitOrder(order: SimOrder, reason?: string): void {
    this.#o.emit({
      type: "order",
      clOrdID: order.clOrdID,
      orderId: order.orderId,
      status: order.status,
      filledQty: order.filledQty,
      reason,
      time: this.#o.now(),
    });
  }
}

const roundDown = (value: ReturnType<typeof toDecimal>, step: string) =>
  canonicalDecimal(value.div(step).floor().mul(step));
const decMin = (a: string, b: string) => (toDecimal(a).lt(b) ? a : b);
const decMax = (a: string, b: string) => (toDecimal(a).gt(b) ? a : b);
