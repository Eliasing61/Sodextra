# @sodextra/api

The dashboard API, built on Node's `http` module with no framework. It listens on `127.0.0.1:3101` and answers only the website's proxy.

| Module                                                                      | Responsibility                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `auth.ts`                                                                   | Wallet sign-in (EIP-4361), sessions, rate limits                   |
| `access.ts`                                                                 | Which wallets may run which bot types                              |
| `keys.ts`                                                                   | Trade-only bot keys: prepare, register, check                      |
| `builder.ts`                                                                | Builder fee approval status and the fee each bot launches with     |
| `launcher.ts`                                                               | Writes bot files and spawns bot processes                          |
| `funds.ts`                                                                  | The margin or balance a bot needs before it starts                 |
| `spots.ts`, `slots.ts`, `egress.ts`                                         | Run spots, server-wide limits and the address each bot trades from |
| `shared-market.ts`                                                          | Keeps a wallet's bots from trading against each other              |
| `resume.ts`, `orphans.ts`                                                   | Auto-resume after a reboot; cleanup of stray bot processes         |
| `views.ts`, `grid-view.ts`, `carry-view.ts`, `profit.ts`, `fill-history.ts` | What the dashboard shows for each bot                              |
| `admin.ts`, `kept.ts`, `marks.ts`                                           | Operator statistics and cached market data                         |

```bash
npm run api     # from the repository root
```

Configuration is read from the repository's `.env`; see [`.env.example`](../../.env.example).
