# Deployment

Production runs in two places: the website on Vercel, and the dashboard API with the bots on an Ubuntu server. The server side is scripted in [`deploy/`](../deploy).

| File                          | Purpose                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `deploy/setup.sh`             | First-time server setup; safe to run again               |
| `deploy/update.sh`            | Later deployments                                        |
| `deploy/sodextra-api.service` | systemd unit for the API (and, through it, the bots)     |
| `deploy/Caddyfile`            | HTTPS for `api.<domain>`, forwarding to `127.0.0.1:3101` |

## Server

Ubuntu 22.04 or 24.04, with an SSH key installed for root.

1. **DNS.** Point `api.<domain>` (an `A` record) at the server, and the main domain at Vercel. Create the `api` record first so Caddy can obtain its certificate as soon as it starts.
2. **Setup.** Copy `deploy/setup.sh` to the server and run it as root with the repository's SSH URL and the domain:

   ```bash
   bash setup.sh git@github.com:<owner>/<repository>.git <domain>
   ```

   The script checks what already runs on the server and stops if the ports it needs are taken, then installs security updates, unattended upgrades, the firewall (22, 80, 443), fail2ban, key-only SSH, Node 24, pnpm and Caddy. It creates a locked-down `sodextra` system user, prints a read-only deploy key to add to the repository, clones the code to `/opt/sodextra`, installs and runs the checks, and writes `.env` (mode 600) with a fresh vault key and proxy secret.

3. **Configure.** Fill in `/opt/sodextra/.env` (see [`.env.example`](../.env.example)), at least `SODEXTRA_ALLOWED_ADDRESSES`, `SODEXTRA_OWNER_ADDRESS` and `SODEXTRA_WEB_ORIGIN`, then run `setup.sh` again. It starts the API and Caddy and prints the values the website needs. Back up `SODEXTRA_VAULT_KEY` somewhere safe.
4. **Check.** `https://api.<domain>/bots` must answer `forbidden`: the API refuses requests that don't come through the website's proxy.

## Website

Import the repository in Vercel with **Root Directory `apps/web`** (Next.js; pnpm is detected from the lockfile), set the variables below, deploy, and add the domain.

| Variable                               | Value                                          |
| -------------------------------------- | ---------------------------------------------- |
| `SODEXTRA_API_URL`                     | `https://api.<domain>`                         |
| `SODEXTRA_PROXY_SECRET`                | The same value as in the server's `.env`       |
| `NEXT_PUBLIC_SODEXTRA_OWNER_ADDRESS`   | The operator's wallet (shows the Admin page)   |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | Optional: a Reown project ID for WalletConnect |

## Updates

Vercel redeploys the website on every push. On the server:

```bash
bash /opt/sodextra/deploy/update.sh
```

It pulls, installs, runs the checks and restarts the API. Running bots keep running on the code they started with (`KillMode=process`); stopping and starting a bot moves it to the new code.

## Services

| Unit                   | Runs                                     | Notes                                                                                             |
| ---------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `sodextra-api.service` | `node --import tsx apps/api/src/main.ts` | `KillMode=process`, `SODEXTRA_AUTO_RESUME=1`, sandboxed; writes only `.sodextra/` and `bots/web/` |
| `caddy.service`        | `/etc/caddy/Caddyfile`                   | TLS, 64 KB request limit, forwards to `127.0.0.1:3101`                                            |

Logs: `journalctl -u sodextra-api -f`, and each bot's output in `/opt/sodextra/.sodextra/logs/`.

## Backups

| Path                    | Back up                                          |
| ----------------------- | ------------------------------------------------ |
| `.sodextra/sodextra.db` | Yes: bots and their full history                 |
| `.sodextra/vault.db`    | Yes, with the vault master key stored separately |
| `bots/web/`             | Yes: the bot files the dashboard wrote           |
| `.sodextra/auth.db`     | No: sign-in sessions only                        |
| `.sodextra/logs/`       | Optional                                         |
