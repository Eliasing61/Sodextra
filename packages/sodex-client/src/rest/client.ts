import { resolveNetwork, type Engine, type Network, type NetworkConfig } from "../config.ts";
import { NonceManager } from "../nonce.ts";
import { OrderRateLimiter, WeightLimiter } from "../rate-limit.ts";
import {
  perpsCancelOrder,
  perpsModifyOrder,
  perpsNewOrder,
  perpsUpdateLeverage,
  perpsUpdateMargin,
  replaceOrder,
  scheduleCancel,
  spotBatchCancelOrder,
  spotBatchNewOrder,
  type PerpsCancelInput,
  type PerpsModifyInput,
  type PerpsNewOrderInput,
  type ReplaceOrderInput,
  type ScheduleCancelInput,
  type SignableAction,
  type SpotCancelInput,
  type SpotNewOrderInput,
  type UpdateLeverageInput,
  type UpdateMarginInput,
} from "../signing/actions.ts";
import { APIKeyType, SignatureType } from "../enums.ts";
import { canonicalJson } from "../signing/canonical-json.ts";
import { walletToWireSignature } from "../signing/eip712.ts";
import type { ActionSigner } from "../signing/signer.ts";
import type {
  AccountApiKeys,
  FeeRate,
  OpenOrders,
  OpenPositions,
  PerpsBalances,
  PerpsFunding,
  PerpsOrder,
  PerpsState,
  SpotBalances,
  SpotOrder,
  SpotState,
  UserRateLimit,
  UserSubaccounts,
  UserTrade,
} from "../types/account.ts";
import type {
  AccountFilter,
  Address,
  BatchItemResult,
  HistoryFilter,
  Hex,
  Uint64,
} from "../types/common.ts";
import type {
  BookTicker,
  Coin,
  Kline,
  KlineQuery,
  MarkPrice,
  MarketTrade,
  OrderBook,
  PerpsKlineInterval,
  PerpsSymbol,
  SpotKlineInterval,
  SpotSymbol,
  Ticker,
} from "../types/market.ts";
import { HttpTransport, type Query } from "./http.ts";

export interface SodexClientOptions {
  network: Network | NetworkConfig;
  /** Required for trading methods. */
  signer?: ActionSigner;
  /** Share one limiter between clients that run on the same IP. */
  weightLimiter?: WeightLimiter;
  orderLimiter?: OrderRateLimiter;
  nonces?: NonceManager;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

const batchWeight = (n: number) => 1 + Math.floor(n / 40);
const historyQuery = (f: HistoryFilter = {}): Query => ({ ...f });

class Context {
  readonly network: NetworkConfig;
  readonly http: HttpTransport;
  readonly nonces: NonceManager;
  readonly orderLimiter: OrderRateLimiter;
  readonly signer: ActionSigner | undefined;

  constructor(options: SodexClientOptions) {
    this.network = resolveNetwork(options.network);
    this.signer = options.signer;
    this.nonces = options.nonces ?? new NonceManager();
    this.orderLimiter = options.orderLimiter ?? new OrderRateLimiter();
    this.http = new HttpTransport({
      baseUrl: this.network.restBaseUrl,
      limiter: options.weightLimiter ?? new WeightLimiter(),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    });
  }

  async signedWrite<T>(
    engine: Engine,
    method: "POST" | "DELETE",
    path: string,
    action: SignableAction,
    weight: number,
    ordersForRateLimit = 0,
  ): Promise<T> {
    const signer = this.signer;
    if (!signer) throw new Error("This call needs a signer (API key private key)");
    if (ordersForRateLimit > 0) {
      await this.orderLimiter.acquire(String(action.params.accountID), ordersForRateLimit);
    }
    const nonce = this.nonces.next(signer.address);
    const sign = await signer.signAction(engine, this.network.chainId, action, nonce);
    return this.http.request<T>({
      method,
      path,
      body: canonicalJson(action.params),
      signed: { sign, nonce, chainId: this.network.chainId, apiKeyName: signer.apiKeyName },
      weight,
    });
  }
}

/** SoDEX (Go) sends empty slices as null; replace null/missing `keys` with [] so callers can always iterate. */
function emptyArrays<T>(data: T, keys: readonly string[]): T {
  if (keys.length === 0 || data === null || typeof data !== "object") return data;
  const record = data as Record<string, unknown>;
  for (const key of keys) record[key] ??= [];
  return data;
}

abstract class EngineApi<TSymbol, TOrder> {
  protected abstract readonly engine: Engine;
  constructor(protected readonly ctx: Context) {}

  protected get base(): string {
    return `/api/v1/${this.engine}`;
  }

  /** GET an object. Go encodes empty slices as null, so the listed `arrayKeys` are turned into []. */
  protected async get<T>(
    path: string,
    weight: number,
    query?: Query,
    arrayKeys: readonly string[] = [],
  ): Promise<T> {
    const data = await this.ctx.http.request<T>({
      method: "GET",
      path: this.base + path,
      weight,
      ...(query ? { query } : {}),
    });
    return emptyArrays(data, arrayKeys);
  }

  /** GET a list; a null body becomes []. */
  protected async getList<T>(path: string, weight: number, query?: Query): Promise<T[]> {
    return (await this.get<T[] | null>(path, weight, query)) ?? [];
  }

  protected account(user: Address, suffix: string): string {
    return `/accounts/${user}${suffix}`;
  }

  // Market data
  symbols(): Promise<TSymbol[]> {
    return this.getList("/markets/symbols", 2);
  }
  coins(): Promise<Coin[]> {
    return this.getList("/markets/coins", 2);
  }
  tickers(): Promise<Ticker[]> {
    return this.getList("/markets/tickers", 2);
  }
  /** Best bid and ask of every symbol, or of one. */
  bookTickers(symbol?: string): Promise<BookTicker[]> {
    return this.getList("/markets/bookTickers", 2, symbol ? { symbol } : undefined);
  }
  orderbook(symbol: string, limit = 10): Promise<OrderBook> {
    const weight = limit <= 100 ? 5 : limit <= 500 ? 10 : 20;
    return this.get(`/markets/${encodeURIComponent(symbol)}/orderbook`, weight, { limit }, [
      "bids",
      "asks",
    ]);
  }
  recentTrades(symbol: string, limit?: number): Promise<MarketTrade[]> {
    return this.getList(`/markets/${encodeURIComponent(symbol)}/trades`, 20, { limit });
  }

  // Account data (no signature needed; pass the master wallet address)
  balances(user: Address, f: AccountFilter = {}): Promise<SpotBalances | PerpsBalances> {
    return this.get(this.account(user, "/balances"), 5, { ...f }, ["balances"]);
  }
  openOrders(
    user: Address,
    f: AccountFilter & { symbol?: string } = {},
  ): Promise<OpenOrders<TOrder>> {
    return this.get(this.account(user, "/orders"), 5, { ...f }, ["orders"]);
  }
  orderHistory(user: Address, f?: HistoryFilter): Promise<TOrder[]> {
    return this.getList(this.account(user, "/orders/history"), 20, historyQuery(f));
  }
  userTrades(user: Address, f?: HistoryFilter): Promise<UserTrade[]> {
    return this.getList(this.account(user, "/trades"), 20, historyQuery(f));
  }
  apiKeys(user: Address, f: AccountFilter = {}): Promise<AccountApiKeys> {
    return this.get(this.account(user, "/api-keys"), 5, { ...f }, ["spot", "perps"]);
  }
  feeRate(user: Address, f: AccountFilter = {}): Promise<FeeRate> {
    return this.get(this.account(user, "/fee-rate"), 2, { ...f });
  }

  /** Cancel-all at a future time (dead-man switch). Omit the timestamp to clear it. */
  scheduleCancel(input: ScheduleCancelInput): Promise<null> {
    return this.ctx.signedWrite(
      this.engine,
      "POST",
      `${this.base}/trade/orders/schedule-cancel`,
      scheduleCancel(input),
      1,
    );
  }

  replaceOrders(input: ReplaceOrderInput): Promise<BatchItemResult[]> {
    const n = input.orders.length;
    return this.ctx.signedWrite(
      this.engine,
      "POST",
      `${this.base}/trade/orders/replace`,
      replaceOrder(input),
      batchWeight(n),
      n,
    );
  }
}

export class PerpsApi extends EngineApi<PerpsSymbol, PerpsOrder> {
  protected readonly engine = "perps" as const;

  markPrices(): Promise<MarkPrice[]> {
    return this.getList("/markets/mark-prices", 2);
  }
  klines(symbol: string, interval: PerpsKlineInterval, q: KlineQuery = {}): Promise<Kline[]> {
    return this.getList(`/markets/${encodeURIComponent(symbol)}/klines`, 20, { interval, ...q });
  }

  /** Account snapshot: balances, positions (with liquidation price), open orders, leverage settings. */
  state(user: Address, f: AccountFilter = {}): Promise<PerpsState> {
    return this.get(this.account(user, "/state"), 5, { ...f }, ["B", "O", "P", "TO", "DO", "S"]);
  }
  override balances(user: Address, f: AccountFilter = {}): Promise<PerpsBalances> {
    return this.get(this.account(user, "/balances"), 5, { ...f }, ["balances"]);
  }
  positions(user: Address, f: AccountFilter = {}): Promise<OpenPositions> {
    return this.get(this.account(user, "/positions"), 5, { ...f }, ["positions"]);
  }
  fundings(user: Address, f?: HistoryFilter): Promise<PerpsFunding[]> {
    return this.getList(this.account(user, "/fundings"), 20, historyQuery(f));
  }

  placeOrders(input: PerpsNewOrderInput): Promise<BatchItemResult[]> {
    const n = input.orders.length;
    return this.ctx.signedWrite(
      "perps",
      "POST",
      `${this.base}/trade/orders`,
      perpsNewOrder(input),
      batchWeight(n),
      n,
    );
  }
  cancelOrders(input: PerpsCancelInput): Promise<BatchItemResult[]> {
    return this.ctx.signedWrite(
      "perps",
      "DELETE",
      `${this.base}/trade/orders`,
      perpsCancelOrder(input),
      batchWeight(input.cancels.length),
    );
  }
  modifyOrder(input: PerpsModifyInput): Promise<unknown> {
    return this.ctx.signedWrite(
      "perps",
      "POST",
      `${this.base}/trade/orders/modify`,
      perpsModifyOrder(input),
      1,
    );
  }
  updateLeverage(input: UpdateLeverageInput): Promise<null> {
    return this.ctx.signedWrite(
      "perps",
      "POST",
      `${this.base}/trade/leverage`,
      perpsUpdateLeverage(input),
      1,
    );
  }
  updateMargin(input: UpdateMarginInput): Promise<null> {
    return this.ctx.signedWrite(
      "perps",
      "POST",
      `${this.base}/trade/margin`,
      perpsUpdateMargin(input),
      1,
    );
  }
}

export class SpotApi extends EngineApi<SpotSymbol, SpotOrder> {
  protected readonly engine = "spot" as const;

  klines(symbol: string, interval: SpotKlineInterval, q: KlineQuery = {}): Promise<Kline[]> {
    return this.getList(`/markets/${encodeURIComponent(symbol)}/klines`, 20, { interval, ...q });
  }
  state(user: Address, f: AccountFilter = {}): Promise<SpotState> {
    return this.get(this.account(user, "/state"), 5, { ...f }, ["B", "O", "TO", "DO"]);
  }
  override balances(user: Address, f: AccountFilter = {}): Promise<SpotBalances> {
    return this.get(this.account(user, "/balances"), 5, { ...f }, ["balances"]);
  }

  placeOrders(input: SpotNewOrderInput): Promise<BatchItemResult[]> {
    const n = input.orders.length;
    return this.ctx.signedWrite(
      "spot",
      "POST",
      `${this.base}/trade/orders/batch`,
      spotBatchNewOrder(input),
      batchWeight(n),
      n,
    );
  }
  cancelOrders(input: SpotCancelInput): Promise<BatchItemResult[]> {
    return this.ctx.signedWrite(
      "spot",
      "DELETE",
      `${this.base}/trade/orders/batch`,
      spotBatchCancelOrder(input),
      batchWeight(input.cancels.length),
    );
  }
}

export class UserApi {
  constructor(private readonly ctx: Context) {}

  async subaccounts(user: Address): Promise<UserSubaccounts> {
    const data = await this.ctx.http.request<UserSubaccounts>({
      method: "GET",
      path: `/api/v1/user/${user}/subaccounts`,
      weight: 20,
    });
    return emptyArrays(data, ["subaccounts"]);
  }
  async apiKeys(
    user: Address,
    query: { accountID?: Uint64 | undefined; name?: string | undefined } = {},
  ): Promise<AccountApiKeys> {
    const data = await this.ctx.http.request<AccountApiKeys>({
      method: "GET",
      path: `/api/v1/user/${user}/api-keys`,
      query,
      weight: 20,
    });
    return emptyArrays(data, ["spot", "perps"]);
  }
  /**
   * Register a permissioned API key on both engines. The master wallet signs
   * `UserSignedAddPermissionedAPIKeyAction` (universal domain; see
   * addPermissionedApiKeyTypedData); pass that wallet signature here as-is.
   */
  addPermissionedApiKey(
    user: Address,
    input: {
      chainId: number;
      nonce: bigint;
      accountID: Uint64;
      name: string;
      publicKey: Address;
      expiresAt: Uint64;
      permissions: number;
      /** The wallet's 65-byte signature (r || s || v, v = 27/28 or 0/1). */
      walletSignature: Hex;
    },
  ): Promise<unknown> {
    return this.ctx.http.request({
      method: "POST",
      path: `/api/v1/user/${user}/api-keys`,
      body: JSON.stringify({
        accountID: input.accountID,
        name: input.name,
        type: APIKeyType.EVM,
        publicKey: input.publicKey,
        expiresAt: input.expiresAt,
        permissions: input.permissions,
      }),
      signed: {
        sign: walletToWireSignature(input.walletSignature, SignatureType.EIP712_UNIVERSAL),
        nonce: input.nonce,
        chainId: input.chainId,
      },
      weight: 20,
    });
  }
  /** Builders this user has approved, per engine (feeRate in tenths of a bp). */
  async builders(user: Address): Promise<{ spot: BuilderApproval[]; perps: BuilderApproval[] }> {
    const data = await this.ctx.http.request<{ spot: BuilderApproval[]; perps: BuilderApproval[] }>(
      {
        method: "GET",
        path: `/api/v1/user/${user}/builders`,
        weight: 20,
      },
    );
    return emptyArrays(data, ["spot", "perps"]);
  }
  /**
   * Approve a builder's maximum fee on both engines. The master wallet signs
   * `ApproveBuilderFeeAction` (approveBuilderFeeTypedData); pass that signature as-is.
   */
  approveBuilderFee(
    user: Address,
    input: {
      chainId: number;
      nonce: bigint;
      accountID: Uint64;
      builderID: Uint64;
      maxFeeRate: number;
      walletSignature: Hex;
    },
  ): Promise<unknown> {
    return this.ctx.http.request({
      method: "POST",
      path: `/api/v1/user/${user}/builders`,
      body: JSON.stringify({
        accountID: input.accountID,
        builderID: input.builderID,
        maxFeeRate: input.maxFeeRate,
      }),
      signed: {
        sign: walletToWireSignature(input.walletSignature, SignatureType.EIP712_UNIVERSAL),
        nonce: input.nonce,
        chainId: input.chainId,
      },
      weight: 20,
    });
  }
  /** Address-based action budget (1 action per 1 USDC traded). */
  rateLimit(user: Address): Promise<UserRateLimit> {
    return this.ctx.http.request({
      method: "GET",
      path: `/api/v1/user/${user}/ratelimit`,
      weight: 20,
    });
  }
}

/** One builder approval (feeRate in tenths of a basis point). */
export interface BuilderApproval {
  userID?: Uint64;
  builderID: Uint64;
  feeRate: number;
}

export class SodexClient {
  readonly network: NetworkConfig;
  readonly perps: PerpsApi;
  readonly spot: SpotApi;
  readonly user: UserApi;
  readonly signer: ActionSigner | undefined;

  constructor(options: SodexClientOptions) {
    const ctx = new Context(options);
    this.network = ctx.network;
    this.signer = ctx.signer;
    this.perps = new PerpsApi(ctx);
    this.spot = new SpotApi(ctx);
    this.user = new UserApi(ctx);
  }
}
