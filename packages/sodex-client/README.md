# @sodextra/sodex-client

A typed client for the SoDEX REST and WebSocket APIs, used by the bots, the API and the scripts.

- **REST:** markets, tickers, order books, candles, account state, orders and trades, for both the spot and perps engines.
- **Trading:** place, replace and cancel orders, leverage and margin mode, the dead-man switch, with EIP-712 signing and nonce management.
- **Account actions:** permissioned API key registration and builder fee approval, signed by the user's wallet.
- **WebSocket:** subscriptions with automatic reconnect and resubscribe, heartbeats, and typed push messages.
- **Numbers:** decimal strings end to end (`decimal.js`, `lossless-json`), plus SoDEX's price and quantity rules.
- **Rate limits:** request weights tracked against SoDEX's per-IP budget.

```bash
npm run smoke:read      # read-only checks against live SoDEX
npm run smoke:signed    # prints a signed round trip; add -- --confirm to place and cancel one far-off order
```
