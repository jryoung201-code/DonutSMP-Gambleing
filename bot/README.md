# Minecraft Bot Worker

This Render background worker connects to the DonutSMP server with the bot's Microsoft account and processes only payment jobs explicitly queued from the protected `/admin` page.

## Required environment

Set these on the bot worker in Render:

- `DATABASE_URL`: the same PostgreSQL connection string used by the backend.
- `MC_SERVER_HOST`: DonutSMP server host.
- `MC_SERVER_PORT`: optional; defaults to `25565`.
- `BOT_MICROSOFT_EMAIL`: Microsoft account email for the bot. This is an identifier, not a password.
- `BOT_AUTH_CACHE_DIR`: optional persistent directory for Minecraft Microsoft sign-in tokens. Set to `/var/data/minecraft-auth` when the worker has a persistent disk mounted at `/var/data`.
- `MC_VERSION`: optional Mineflayer protocol version; autodetects by default.

The first connection may request Microsoft device sign-in. Complete the code shown in the worker logs while signed into the bot's Microsoft account. Never share those logs while a sign-in code is active. Keep the auth cache on a persistent disk so Render restarts do not require a fresh sign-in.

## Payment handling

- The worker reads the PostgreSQL queue created by the authenticated admin page.
- It only sends `/pay <player> <amount>` for an approved queued job. It has no chat listener that accepts commands.
- It records the server's clear success or rejection response when available.
- A timeout, disconnection, or restart after dispatch is marked `uncertain`. The worker never retries an uncertain payment automatically because the server may already have processed it. Check in game before manually issuing another payment.
- The admin page caps one payment at `ADMIN_MAX_FORCE_PAY` (default `5000000`).

The bot's verified Java profile UUID and name are stored in `bot_identity`. The admin page requires a Microsoft sign-in that resolves to the same profile.

## Run locally

From this directory, install dependencies with `npm install` and start with `npm start`. Provide the required environment variables above. The process needs outbound network access to the Minecraft server and Microsoft authentication services.
