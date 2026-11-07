# Bots

Every bot is a strategy run by the same engine, with the same guarantees: its own `risk` block, its own state, its own orders recognizable by their client order IDs, and a full record of every order, fill and run. Users create and control bots from the dashboard; bot files can also be run from the terminal with `apps/cli`.

| Bot           | Strategy      | Market        | Access      | Source in this repository |
| ------------- | ------------- | ------------- | ----------- | ------------------------- |
| Maker Volume  | `maker`       | Perps         | Open        | Proprietary               |
| Grid          | `grid`        | Perps or spot | Open        | Included                  |
| Taker Volume  | `taker`       | Perps         | Open        | Proprietary               |
| Edge          | `profit`      | Perps         | Invite-only | Proprietary               |
| Spot Edge     | `spot-profit` | Spot          | Invite-only | Proprietary               |
| Stock Edge    | `stock`       | Perps         | Invite-only | Proprietary               |
| Funding Carry | `carry`       | Perps + spot  | Invite-only | Proprietary               |
| Probe         | `probe`       | Perps or spot | Terminal    | Included                  |

## Maker Volume

Builds trading volume as a market maker. The bot quotes both sides of the book with post-only orders, so every fill pays the maker fee, and keeps its inventory small. The dashboard shows the volume made and its cost per $1M traded.

## Grid

Buys low and sells high across a price range. The range is split into price lines, arithmetic or geometric; a filled buy is answered by a sell one line up, and a filled sell by a buy one line down, so each round trip earns the distance between two lines.

| Type      | Behavior                                                                      |
| --------- | ----------------------------------------------------------------------------- |
| `neutral` | Starts flat: buys below the price fill into a long, sells above into a short. |
| `long`    | Starts long with the size the sells above will close.                         |
| `short`   | The mirror of `long`.                                                         |
| `spot`    | Like `long`, without leverage, on a spot market.                              |

Options include stop-losses below and above the range, a take-profit as a share of the investment, a trigger price to start from, and whether a stop also closes the position. The implementation is in [`packages/strategies/src/grid`](../packages/strategies/src/grid) and the example in [`bots/example-grid.json`](../bots/example-grid.json).

## Taker Volume

Opens and closes small positions with market orders in quick rounds, alternating sides, so every trade counts as taker volume. Optional smart timing follows a leading external price to choose when to trade. The bot stops at its volume target, its loss limit or its cost limit.

## Edge

Trades only where the spread pays more than the fee. The bot quotes inside wide spreads, keeps a small position, and pauses through sudden moves. It makes little volume by design.

## Spot Edge

Edge on SoDEX spot markets, holding a small inventory of the coin instead of a perps position.

## Stock Edge

Earns the wide spreads of US stock perpetuals while Wall Street is closed: overnight, on weekends and on US market holidays. It is flat before the US market opens.

## Funding Carry

Collects the funding that shorts are paid. The bot holds a short perpetual position hedged by the same amount of the coin on spot, so price moves cancel out.

## Probe

An engine check rather than a trading strategy: it keeps one post-only order far from the market and moves it as the price drifts. It is not meant to fill, which makes it a free way to test the engine end to end on mainnet. Example: [`bots/example-probe.json`](../bots/example-probe.json).

## Access

Open bots are available to every signed-in wallet, within the server's run spots. Invite-only bots are available to the operator's wallet and to the wallets listed for that bot type (see `.env.example`). Probe and Funding Carry's per-leg bots are not created from the dashboard.

## Fees

Bot orders pay SoDEX's normal trading fees. Orders also carry Sodextra's SoDEX builder code, a small fee on top that each user approves once in Setup with a wallet signature. A user who has not approved it cannot start bots; the approval can be revoked on SoDEX.
