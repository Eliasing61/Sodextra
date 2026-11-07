# @sodextra/cli

The bot runner. The dashboard API starts one runner process per bot; the same commands are available from the terminal for development.

```bash
npm run bot -- validate <bot.json>              # check a config against live market data (signs nothing)
npm run bot -- backtest <bot.json> [--days 7]   # simulate on recent 1-minute candles
npm run bot -- paper    <bot.json>              # live prices, simulated orders
npm run bot -- live     <bot.json> --confirm    # real orders (needs risk.maxNotional)
npm run bot -- status   [bot.json]              # saved state, orders and recent events
npm run bot -- stop     <bot.json> [--close]    # cancel the bot's orders; --close also closes its position
npm run bot -- panic    [--close]               # cancel every Sodextra order on the account
npm run bot -- list                             # every bot in the local database
npm run bot -- forget   <name|id> --confirm     # delete a stopped bot and its history
```

| Module        | Responsibility                                                    |
| ------------- | ----------------------------------------------------------------- |
| `bot-file.ts` | Loads and checks bot files                                        |
| `env.ts`      | Settings from `.env`, data paths, the signer and the builder code |
| `vault.ts`    | The encrypted key vault (AES-256-GCM)                             |
| `egress.ts`   | Sends a bot's SoDEX traffic from its assigned address             |
| `lock.ts`     | One process per bot                                               |
| `commands/`   | The commands above                                                |
