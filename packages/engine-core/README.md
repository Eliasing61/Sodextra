# @sodextra/engine-core

The trading engine every bot runs on. Strategies decide which orders they want; the engine makes the exchange match, safely.

| Module                  | Responsibility                                                                   |
| ----------------------- | -------------------------------------------------------------------------------- |
| `strategy.ts`           | The `Strategy` interface and the context a strategy sees                         |
| `engine.ts`             | The cycle: market events, desired orders, reconciliation, risk, safety, commands |
| `order-diff.ts`         | Desired orders against open orders: what to place, replace and cancel            |
| `risk.ts`               | Per-bot limits: exposure, position, loss, open orders, leverage                  |
| `position.ts`           | Position, realized and unrealized PnL, fees                                      |
| `ids.ts`                | Client order IDs that tie every order to its bot                                 |
| `runner.ts`             | Timers: event cycles, idle cycles, reconciliation every 30 seconds               |
| `live/`                 | The SoDEX exchange adapter, quiet-book polling and an external price feed        |
| `sim/`                  | Paper trading on live prices, and candle backtests                               |
| `store/sqlite-store.ts` | Bots, orders, fills, events, runs and PnL samples in SQLite (`node:sqlite`)      |

The same strategy code runs live, in paper mode and in backtests. See [docs/architecture.md](../../docs/architecture.md#engine).
