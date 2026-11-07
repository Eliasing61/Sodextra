# Security

Sodextra trades on its users' SoDEX accounts without ever holding their funds or their wallet keys. This document describes what is protected, the threats considered, and the defenses in place.

## Assets

| Asset                                | Where it lives                                    | Worst case if stolen                                                                 |
| ------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------ |
| A user's wallet key                  | Only in the user's wallet; never sent to Sodextra | Not applicable                                                                       |
| Bot API keys (sign orders)           | The server's key vault, encrypted at rest         | Unwanted trading within each bot's limits. The keys **cannot withdraw or transfer**. |
| Control of bots (start, stop, close) | The dashboard API                                 | Someone starts a bot or closes a position                                            |
| Trading data (positions, PnL, fills) | SQLite on the server                              | Loss of privacy                                                                      |

## Threats and defenses

### Unauthorized use of the dashboard or API

- **Wallet sign-in** with [EIP-4361 (Sign-In with Ethereum)](https://eips.ethereum.org/EIPS/eip-4361). The wallet signs a readable message: no transaction, no gas.
- **Sign-in messages** are checked for the domain and origin, a single-use nonce (5 minutes), the issue time, a 10-minute expiry, and a valid signature from the claimed address.
- **Who can sign in** is set by `SODEXTRA_ALLOWED_ADDRESSES` (listed wallets, or `*` for any wallet). With no allowlist, the API refuses to start.
- **Per-wallet isolation.** Every bot belongs to the wallet that created it, set by the server from the session, never from the request. A wallet only sees, starts and stops its own bots and keys, and its bots trade only its own account with its own key.
- **Sessions** are 256-bit random tokens in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie. The server stores only their SHA-256 hash, so a copied database can't be used to sign in. Sessions expire after 7 days and end on sign-out.
- **Brute force:** sign-in attempts are rate-limited per client address.
- **Limits** per wallet and per server cap how many bots can run.

### Cross-site requests

- `SameSite=Strict` cookies, and every write must be `application/json` from the site's own origin, which forces a CORS preflight that is never approved, plus an `Origin` check.
- The API only answers the website's `/api` proxy, which proves itself with a 256-bit shared secret compared in constant time. Without a secret (local development), the API checks `Host` against DNS rebinding.
- The site can't be framed (`frame-ancestors 'none'`, `X-Frame-Options: DENY`).
- Live starts require an explicit confirmation in the interface and in the API call.

### Injected scripts (XSS)

- React escapes all output; raw HTML is never injected.
- **Content-Security-Policy:** scripts only from the site's own origin; network access only to the site itself, SoDEX's gateway and the ValueChain RPC; no plugins; no framing.
- Session cookies are `HttpOnly`, so even injected script can't read them.
- Other headers: `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Opener-Policy`, and HSTS in production.

### Server compromise

- Bot keys **can't withdraw or transfer** funds, so the worst case is unwanted trading, bounded by each bot's risk limits. Users can revoke a key on sodex.com at any time.
- Bot keys are sealed with AES-256-GCM under a master key that lives only in the server's environment, never in the database or the repository.
- The API and the bots run as an unprivileged system user in a systemd sandbox: read-only system, no new privileges, no capabilities, private `/tmp` and `/dev`, writes limited to the data folders.
- `.env` is readable only by the service user.

### Network

- Everything is served over HTTPS with HSTS. The API listens on `127.0.0.1` only; Caddy terminates TLS in front of it.
- The firewall allows SSH, HTTP and HTTPS only; SSH accepts keys only, and fail2ban blocks repeated failures.

## Bot keys

1. **Prepare.** The server generates the key pair inside the vault, sealed with AES-256-GCM and bound to its record. It returns only the public address and the SoDEX message to sign.
2. **Sign.** The user's wallet signs SoDEX's permissioned API key action. The key can place and cancel orders; withdrawals and transfers are disabled. It expires after 90 days.
3. **Register.** The server checks that the signature recovers to the signed-in wallet, submits it to SoDEX, and activates the key once SoDEX lists it.
4. **Use.** Each bot signs with its owner's newest active key.

Private keys never leave the server, never reach the browser and are never logged. Losing the vault master key only means creating new bot keys.

## Builder fee approval

Sodextra's builder fee is approved by the user with a wallet signature in Setup, for a maximum rate the user sees before signing. Bots never charge more than the rate a user approved, and a user can revoke the approval on SoDEX.

## Principles

1. Never ask for or handle a wallet's private key or seed phrase.
2. Only trade-only bot keys; never a key that can withdraw.
3. Fail closed: no allowlist, no session, no start.
4. Secrets never go into version control, logs, URLs or the browser.
5. Every real-money action is explicit and confirmed.

## Reporting a vulnerability

Please report security issues privately through GitHub's vulnerability reporting for this repository, not in public issues.
