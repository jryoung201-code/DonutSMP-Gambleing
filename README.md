# DonutSMP Game Hub

This repository is being repurposed from the old horse-racing AI project into the DonutSMP Game Hub.

## Planned components

- **Fabric mod** — in-game GUI containing all games.
- **Server/backend** — authoritative configuration, bet validation, game state, and audit records.
- **Minecraft bot** — handles the configured in-game payment account integration.
- **Render** — hosts the backend API.
- **GitHub** — source control and deployment source.

## GUI

Games:

- 50/50
- Wheel
- 45/45/10 (display name remains 45/45/10)
- Horse Racing
- Odd or Even
- Crates (no bet input)

Bet amounts accept formats such as `500k`, `2m`, `10m`, `1b`, `1t`, and plain numbers.

## Default server settings

- Minimum bet: `100k`
- Maximum bet: `2m`
- Payment target: `VoduDoll_YT`

The payment target and limits are intended to be changeable server-side without requiring a client-mod update.

## Security model

The server/backend is authoritative. The client must not be trusted for balance, bet amount, limits, game results, or payout destination. Every transaction must be validated server-side and recorded before a payment action is authorized.

## Repository layout

```
mod/       Fabric client mod
server/    server-side configuration/API contract
backend/   Render-hosted backend
bot/       Minecraft bot integration
```

The old horse-racing AI implementation is no longer part of the project.


## Admin page and bot payments

The Render backend serves the admin page at `/admin`. Sign in with the same Microsoft account and Minecraft Java profile used by the bot. The bot must connect and record its verified profile UUID before admin sign-in can succeed.

The page can update minimum and maximum amounts, payment target, visible odds, and enabled games. It can also queue a manually confirmed `/pay <player> <amount>` payment for the bot. Payments are queued in PostgreSQL and capped by `ADMIN_MAX_FORCE_PAY` (default `5000000`). A timeout or disconnect after sending is marked `uncertain`; check in game before issuing another payment.

## Render setup

The repository's Render Blueprint deploys the API and database. Create a separate Render background worker using the `bot/` directory, build command `npm install`, and start command `npm start`. Configure the worker with the same `DATABASE_URL` as the API, plus `MC_SERVER_HOST`, `BOT_MICROSOFT_EMAIL`, and optionally `MC_SERVER_PORT` and `MC_VERSION`. Use a persistent disk mounted at `/var/data` and set `BOT_AUTH_CACHE_DIR=/var/data/minecraft-auth` so Microsoft sign-in tokens survive worker restarts. Follow the first-run device sign-in prompt in the worker logs. See [bot/README.md](bot/README.md) for details.

The admin session uses an HttpOnly, Secure, SameSite cookie and expires after eight hours.