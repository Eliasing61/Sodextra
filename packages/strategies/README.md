# @sodextra/strategies

Strategy implementations for `@sodextra/engine-core`. A strategy is pure decision logic: it keeps its own state and returns the orders it wants on the book; the engine does the rest.

| Strategy | Path         | Description                                                                            |
| -------- | ------------ | -------------------------------------------------------------------------------------- |
| `grid`   | `src/grid/`  | Grid trading on perps (neutral, long, short) or spot, with stop-losses and take-profit |
| `probe`  | `src/probe/` | An engine check: one post-only order far from the market                               |

Sodextra's production strategies (Maker Volume, Taker Volume, Edge, Spot Edge, Stock Edge and Funding Carry) implement the same interface and are not part of this repository.

The grid is split into its settings (`config.ts`), its price math (`math.ts`, pure functions) and its behavior (`grid.ts`), each covered by tests in `test/grid.test.ts`.
