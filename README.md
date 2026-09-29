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


## Protected admin configuration

The Render backend serves a password-protected admin page at `/admin`. It can update and persist the minimum and maximum amounts, payment target, visible odds setting, and enabled games.

Before signing in, set `ADMIN_PASSWORD` in the Render web service's Environment settings. Choose a private password with at least 12 characters; do not put it in GitHub or paste it into chat. Save the environment change and let Render redeploy. Then open `https://<your-render-service>/admin`.

The admin session uses an HttpOnly, Secure, SameSite cookie and expires after eight hours. Failed sign-in attempts are rate limited. The config API rejects unauthenticated requests and validates all submitted settings server-side.
