/** uint64 from the API: a number when it fits safely, otherwise a bigint. */
export type Uint64 = number | bigint;

/** Decimal values travel as strings and must never be converted to floats for trading. */
export type DecimalString = string;

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

/** Error envelope returned for rejected requests (code < 0). */
export interface ApiEnvelope<T> {
  code: number;
  timestamp: number;
  error?: string;
  data: T;
}

/** Per-item result of batch writes (place/cancel/replace). */
export interface BatchItemResult {
  code: number;
  clOrdID?: string;
  orderID?: Uint64;
  error?: string;
}

export interface HistoryFilter {
  accountID?: Uint64;
  symbol?: string;
  orderID?: Uint64;
  startTime?: number;
  endTime?: number;
  limit?: number;
}

export interface AccountFilter {
  accountID?: Uint64;
}
