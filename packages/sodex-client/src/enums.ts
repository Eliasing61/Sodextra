// Requests use the integer values below. Responses (REST and WS) return the
// string names instead, e.g. side "BUY" — see the *Name types.

type ValueOf<T> = T[keyof T];

export const OrderSide = { BUY: 1, SELL: 2 } as const;
export type OrderSide = ValueOf<typeof OrderSide>;
export type OrderSideName = keyof typeof OrderSide;

export const OrderType = { LIMIT: 1, MARKET: 2 } as const;
export type OrderType = ValueOf<typeof OrderType>;
export type OrderTypeName = keyof typeof OrderType;

/** GTX = post-only. FOK is documented but not supported yet. */
export const TimeInForce = { GTC: 1, FOK: 2, IOC: 3, GTX: 4 } as const;
export type TimeInForce = ValueOf<typeof TimeInForce>;
export type TimeInForceName = keyof typeof TimeInForce;

export const OrderStatus = {
  NEW: 1,
  PARTIALLY_FILLED: 2,
  FILLED: 3,
  CANCELED: 4,
  REJECTED: 5,
  EXPIRED: 6,
  TRIGGERED: 10,
} as const;
export type OrderStatus = ValueOf<typeof OrderStatus>;
export type OrderStatusName = keyof typeof OrderStatus;

export const ExecutionType = {
  NEW: 1,
  PARTIALLY_FILLED: 2,
  FILLED: 3,
  CANCELED: 4,
  REJECTED: 5,
  MODIFIED: 6,
  EXPIRED: 7,
  REPLACED: 8,
} as const;
export type ExecutionType = ValueOf<typeof ExecutionType>;
export type ExecutionTypeName = keyof typeof ExecutionType;

/** Perps only. */
export const OrderModifier = { NORMAL: 1, STOP: 2, BRACKET: 3, ATTACHED_STOP: 4 } as const;
export type OrderModifier = ValueOf<typeof OrderModifier>;

/** Perps only. */
export const MarginMode = { ISOLATED: 1, CROSS: 2 } as const;
export type MarginMode = ValueOf<typeof MarginMode>;
export type MarginModeName = keyof typeof MarginMode;

/** Perps only. Only BOTH (one-way mode) is accepted for order placement today. */
export const PositionSide = { BOTH: 1, LONG: 2, SHORT: 3 } as const;
export type PositionSide = ValueOf<typeof PositionSide>;
export type PositionSideName = keyof typeof PositionSide;

/** Perps only. */
export const StopType = { STOP_LOSS: 1, TAKE_PROFIT: 2 } as const;
export type StopType = ValueOf<typeof StopType>;
export type StopTypeName = keyof typeof StopType;

/** Perps only. Only MARK_PRICE is accepted for order placement today. */
export const TriggerType = { LAST_PRICE: 1, MARK_PRICE: 2, INDEX_PRICE: 3 } as const;
export type TriggerType = ValueOf<typeof TriggerType>;
export type TriggerTypeName = keyof typeof TriggerType;

export const APIKeyType = { EVM: 1 } as const;
export type APIKeyType = ValueOf<typeof APIKeyType>;

/** Bit mask; a SET bit DISABLES the permission. */
export const APIKeyPermission = { TRADE: 1, CANCEL: 2, WITHDRAW: 4, TRANSFER: 8 } as const;

/** First byte of X-API-Sign. */
export const SignatureType = { EIP712: 1, EIP712_UNIVERSAL: 2 } as const;
export type SignatureType = ValueOf<typeof SignatureType>;
