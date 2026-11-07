import { toDecimal } from "@sodextra/sodex-client";

import type { DesiredOrder, TrackedOrder } from "./types.ts";
import { CLOSED_STATUSES } from "./types.ts";

export interface OrderDiff {
  /** Live orders to cancel: no longer wanted, or wanted with different terms. */
  cancel: TrackedOrder[];
  /** Wanted orders with no live order for their key. */
  place: DesiredOrder[];
  /** Live orders to move to a new price/size in one atomic action (when the exchange supports it). */
  replace: { order: TrackedOrder; want: DesiredOrder }[];
  /** Keys waiting for an in-flight request to resolve; nothing is sent for them this cycle. */
  waiting: string[];
}

export interface DiffOptions {
  /** The exchange can replace orders atomically (SoDEX `replace`). */
  canReplace?: boolean;
}

const sameDecimal = (a: string | undefined, b: string | undefined) =>
  a === undefined || b === undefined ? a === b : toDecimal(a).eq(toDecimal(b));

export function matches(desired: DesiredOrder, order: TrackedOrder): boolean {
  if (desired.side !== order.side || desired.kind !== order.kind) return false;
  if (Boolean(desired.reduceOnly) !== order.reduceOnly) return false;
  if (Boolean(desired.ioc) !== Boolean(order.ioc)) return false;
  if (desired.kind === "limit") {
    return sameDecimal(desired.price, order.price) && sameDecimal(desired.quantity, order.quantity);
  }
  return (
    sameDecimal(desired.stopPrice, order.stopPrice) &&
    sameDecimal(desired.quantity, order.quantity) &&
    desired.stopType === order.stopType
  );
}

/**
 * Can `order` be moved to `want` with one replace? SoDEX replaces only resting
 * GTC/GTX limits; we also require it to be completely unfilled (replace
 * semantics for partly filled orders aren't documented) and the order type to
 * stay the same (side, reduce-only, post-only-ness).
 */
export function replaceable(want: DesiredOrder, order: TrackedOrder): boolean {
  return (
    want.kind === "limit" &&
    order.kind === "limit" &&
    !want.ioc &&
    !order.ioc &&
    want.side === order.side &&
    Boolean(want.reduceOnly) === order.reduceOnly &&
    (want.postOnly !== false) === order.postOnly &&
    order.status === "open" &&
    toDecimal(order.filledQty).isZero() &&
    want.price !== undefined &&
    want.quantity !== undefined
  );
}

/**
 * Compare what the strategy wants with what is live, per key.
 *
 * Conservative rules so we never double up exposure:
 * - a key with a pending/cancelling/unknown order gets nothing new until that resolves;
 * - a key whose live order differs is replaced atomically when possible, otherwise
 *   cancelled first and re-placed next cycle, after the cancel is confirmed
 *   (never cancel + place in the same cycle).
 */
export function diffOrders(
  desired: DesiredOrder[],
  active: TrackedOrder[],
  options: DiffOptions = {},
): OrderDiff {
  const byKey = new Map<string, TrackedOrder[]>();
  for (const order of active) {
    if (CLOSED_STATUSES.has(order.status)) continue;
    byKey.set(order.key, [...(byKey.get(order.key) ?? []), order]);
  }

  const wantedKeys = new Set<string>();
  const result: OrderDiff = { cancel: [], place: [], replace: [], waiting: [] };

  for (const want of desired) {
    if (wantedKeys.has(want.key))
      throw new Error(`Strategy returned duplicate order key "${want.key}"`);
    wantedKeys.add(want.key);

    const live = byKey.get(want.key) ?? [];
    if (live.length === 0) {
      result.place.push(want);
      continue;
    }
    if (
      live.some(
        (o) => o.status === "pending" || o.status === "cancelling" || o.status === "unknown",
      )
    ) {
      result.waiting.push(want.key);
      continue;
    }
    const keep = live.find((o) => matches(want, o));
    if (keep) {
      for (const o of live) if (o !== keep) result.cancel.push(o);
      continue;
    }
    const [first, ...rest] = live;
    if (options.canReplace && rest.length === 0 && first && replaceable(want, first)) {
      result.replace.push({ order: first, want });
      continue;
    }
    for (const o of live) result.cancel.push(o);
    result.waiting.push(want.key);
  }

  for (const [key, live] of byKey) {
    if (wantedKeys.has(key)) continue;
    for (const o of live) {
      if (o.status === "open" || o.status === "partially_filled") result.cancel.push(o);
      else result.waiting.push(key);
    }
  }
  return result;
}
