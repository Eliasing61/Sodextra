// Builders for every signed trading action we use. Each one returns the
// `{type, params}` payload that gets hashed and signed; the HTTP body is `params`.
//
// Field order in each object literal MUST match the Go struct field order in
// sodex-go-sdk-public — the server re-marshals the body with json.Marshal and
// hashes that. Optional (omitempty) fields are left undefined so they are omitted.

import { canonicalDecimal, type DecimalInput } from "../decimal.ts";
import {
  MarginMode,
  OrderModifier,
  PositionSide,
  type OrderSide,
  type OrderType,
  type StopType,
  type TimeInForce,
  type TriggerType,
} from "../enums.ts";
import type { Uint64 } from "../types/common.ts";
import type { CanonicalValue } from "./canonical-json.ts";

export type ActionParams = { [key: string]: CanonicalValue };

// A type alias (not an interface) so it stays assignable to CanonicalValue.
export type SignableAction<T extends string = string, P extends ActionParams = ActionParams> = {
  type: T;
  params: P;
};

/** Builder fee attached to orders. Not used yet (plan Phase 8); leave undefined. */
export interface BuilderParams {
  id: Uint64;
  /** Tenths of a basis point: 10 = 1 bp. */
  fee: number;
}

const CL_ORD_ID = /^[0-9a-zA-Z_-]{1,36}$/;
const MAX_BATCH = 100;

function clOrdId(value: string): string {
  if (!CL_ORD_ID.test(value)) throw new Error(`Invalid clOrdID "${value}" (^[0-9a-zA-Z_-]{1,36}$)`);
  return value;
}

function dec(value: DecimalInput | undefined): string | undefined {
  return value === undefined ? undefined : canonicalDecimal(value);
}

function batch<T>(items: T[], what: string): T[] {
  if (items.length === 0) throw new Error(`${what}: batch cannot be empty`);
  if (items.length > MAX_BATCH) throw new Error(`${what}: batch exceeds ${MAX_BATCH} items`);
  return items;
}

function builder(b: BuilderParams | undefined): ActionParams | undefined {
  return b === undefined ? undefined : { id: b.id, fee: b.fee };
}

// ── Perps ─────────────────────────────────────────────────────────────────────

export interface PerpsOrderInput {
  clOrdID: string;
  /** Default NORMAL. */
  modifier?: OrderModifier | undefined;
  side: OrderSide;
  type: OrderType;
  timeInForce: TimeInForce;
  price?: DecimalInput | undefined;
  quantity?: DecimalInput | undefined;
  /** Market buy only. */
  funds?: DecimalInput | undefined;
  stopPrice?: DecimalInput | undefined;
  stopType?: StopType | undefined;
  triggerType?: TriggerType | undefined;
  /** Default false. */
  reduceOnly?: boolean | undefined;
  /** Default BOTH (the only supported value today). */
  positionSide?: PositionSide | undefined;
}

export interface PerpsNewOrderInput {
  accountID: Uint64;
  symbolID: number;
  orders: PerpsOrderInput[];
  builder?: BuilderParams | undefined;
}

export function perpsNewOrder(input: PerpsNewOrderInput): SignableAction<"newOrder"> {
  return {
    type: "newOrder",
    params: {
      accountID: input.accountID,
      symbolID: input.symbolID,
      orders: batch(input.orders, "newOrder").map((o) => ({
        clOrdID: clOrdId(o.clOrdID),
        modifier: o.modifier ?? OrderModifier.NORMAL,
        side: o.side,
        type: o.type,
        timeInForce: o.timeInForce,
        price: dec(o.price),
        quantity: dec(o.quantity),
        funds: dec(o.funds),
        stopPrice: dec(o.stopPrice),
        stopType: o.stopType,
        triggerType: o.triggerType,
        reduceOnly: o.reduceOnly ?? false,
        positionSide: o.positionSide ?? PositionSide.BOTH,
      })),
      builder: builder(input.builder),
    },
  };
}

/** Identify each order by exactly one of orderID or clOrdID. */
export interface PerpsCancelInput {
  accountID: Uint64;
  cancels: { symbolID: number; orderID?: Uint64 | undefined; clOrdID?: string | undefined }[];
}

export function perpsCancelOrder(input: PerpsCancelInput): SignableAction<"cancelOrder"> {
  return {
    type: "cancelOrder",
    params: {
      accountID: input.accountID,
      cancels: batch(input.cancels, "cancelOrder").map((c) => {
        if ((c.orderID === undefined) === (c.clOrdID === undefined)) {
          throw new Error("cancelOrder: provide exactly one of orderID or clOrdID");
        }
        return {
          symbolID: c.symbolID,
          orderID: c.orderID,
          clOrdID: c.clOrdID === undefined ? undefined : clOrdId(c.clOrdID),
        };
      }),
    },
  };
}

export interface PerpsModifyInput {
  accountID: Uint64;
  symbolID: number;
  orderID?: Uint64 | undefined;
  clOrdID?: string | undefined;
  price?: DecimalInput | undefined;
  quantity?: DecimalInput | undefined;
  stopPrice?: DecimalInput | undefined;
}

export function perpsModifyOrder(input: PerpsModifyInput): SignableAction<"modifyOrder"> {
  return {
    type: "modifyOrder",
    params: {
      accountID: input.accountID,
      symbolID: input.symbolID,
      orderID: input.orderID,
      clOrdID: input.clOrdID === undefined ? undefined : clOrdId(input.clOrdID),
      price: dec(input.price),
      quantity: dec(input.quantity),
      stopPrice: dec(input.stopPrice),
    },
  };
}

export interface UpdateLeverageInput {
  accountID: Uint64;
  symbolID: number;
  leverage: number;
  marginMode: MarginMode;
}

export function perpsUpdateLeverage(input: UpdateLeverageInput): SignableAction<"updateLeverage"> {
  if (!Number.isInteger(input.leverage) || input.leverage < 1) {
    throw new Error("updateLeverage: leverage must be a positive integer");
  }
  if (input.marginMode !== MarginMode.ISOLATED && input.marginMode !== MarginMode.CROSS) {
    throw new Error("updateLeverage: invalid marginMode");
  }
  return {
    type: "updateLeverage",
    params: {
      accountID: input.accountID,
      symbolID: input.symbolID,
      leverage: input.leverage,
      marginMode: input.marginMode,
    },
  };
}

export interface UpdateMarginInput {
  accountID: Uint64;
  symbolID: number;
  /** Positive adds isolated margin, negative removes it. */
  amount: DecimalInput;
}

export function perpsUpdateMargin(input: UpdateMarginInput): SignableAction<"updateMargin"> {
  return {
    type: "updateMargin",
    params: {
      accountID: input.accountID,
      symbolID: input.symbolID,
      amount: canonicalDecimal(input.amount),
    },
  };
}

// ── Spot ──────────────────────────────────────────────────────────────────────

export interface SpotOrderInput {
  symbolID: number;
  clOrdID: string;
  side: OrderSide;
  type: OrderType;
  timeInForce: TimeInForce;
  price?: DecimalInput | undefined;
  quantity?: DecimalInput | undefined;
  funds?: DecimalInput | undefined;
}

export interface SpotNewOrderInput {
  accountID: Uint64;
  orders: SpotOrderInput[];
  builder?: BuilderParams | undefined;
}

export function spotBatchNewOrder(input: SpotNewOrderInput): SignableAction<"batchNewOrder"> {
  return {
    type: "batchNewOrder",
    params: {
      accountID: input.accountID,
      orders: batch(input.orders, "batchNewOrder").map((o) => ({
        symbolID: o.symbolID,
        clOrdID: clOrdId(o.clOrdID),
        side: o.side,
        type: o.type,
        timeInForce: o.timeInForce,
        price: dec(o.price),
        quantity: dec(o.quantity),
        funds: dec(o.funds),
      })),
      builder: builder(input.builder),
    },
  };
}

/**
 * Spot cancels carry their own clOrdID (an ID for the cancel request itself) and
 * identify the target order by orderID or origClOrdID.
 */
export interface SpotCancelInput {
  accountID: Uint64;
  cancels: { symbolID: number; clOrdID: string; orderID?: Uint64; origClOrdID?: string }[];
}

export function spotBatchCancelOrder(input: SpotCancelInput): SignableAction<"batchCancelOrder"> {
  return {
    type: "batchCancelOrder",
    params: {
      accountID: input.accountID,
      cancels: batch(input.cancels, "batchCancelOrder").map((c) => {
        if ((c.orderID === undefined) === (c.origClOrdID === undefined)) {
          throw new Error("batchCancelOrder: provide exactly one of orderID or origClOrdID");
        }
        return {
          symbolID: c.symbolID,
          clOrdID: clOrdId(c.clOrdID),
          orderID: c.orderID,
          origClOrdID: c.origClOrdID === undefined ? undefined : clOrdId(c.origClOrdID),
        };
      }),
    },
  };
}

// ── Shared (both engines) ─────────────────────────────────────────────────────

export interface ReplaceOrderInput {
  accountID: Uint64;
  orders: {
    symbolID: number;
    /** New clOrdID for the replacement order. */
    clOrdID: string;
    origOrderID?: Uint64 | undefined;
    origClOrdID?: string | undefined;
    price?: DecimalInput | undefined;
    quantity?: DecimalInput | undefined;
  }[];
}

export function replaceOrder(input: ReplaceOrderInput): SignableAction<"replaceOrder"> {
  return {
    type: "replaceOrder",
    params: {
      accountID: input.accountID,
      orders: batch(input.orders, "replaceOrder").map((o) => ({
        symbolID: o.symbolID,
        clOrdID: clOrdId(o.clOrdID),
        origOrderID: o.origOrderID,
        origClOrdID: o.origClOrdID === undefined ? undefined : clOrdId(o.origClOrdID),
        price: dec(o.price),
        quantity: dec(o.quantity),
      })),
    },
  };
}

export interface ScheduleCancelInput {
  accountID: Uint64;
  /** Ms timestamp ≥ now + 5 s. Omit to clear the scheduled cancel. Max 10 triggers per UTC day. */
  scheduledTimestamp?: number | undefined;
}

export function scheduleCancel(input: ScheduleCancelInput): SignableAction<"scheduleCancel"> {
  return {
    type: "scheduleCancel",
    params: { accountID: input.accountID, scheduledTimestamp: input.scheduledTimestamp },
  };
}

/** Must be signed by the master wallet, not an API key. */
export function revokeApiKey(input: {
  accountID: Uint64;
  name: string;
}): SignableAction<"revokeAPIKey"> {
  return { type: "revokeAPIKey", params: { accountID: input.accountID, name: input.name } };
}
