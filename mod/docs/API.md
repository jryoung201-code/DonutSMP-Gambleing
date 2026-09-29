# DonutSMP Game Hub - backend API contract (v1)

The backend is the ONLY implementation of game logic. The mod sends input and animates what it is told.
All money is DonutSMP in-game currency, stored and computed as 64-bit integers.

Authentication uses the Mojang session flow:
1. POST /api/auth/challenge
2. Client calls Mojang joinServer
3. POST /api/auth/login
4. Later requests use Authorization: Bearer <token>

The wire game IDs are 50_50, wheel, crates, horseRacing, 45_45_10, and oddEven.

See the backend repository/API contract for the complete response detail schema and transaction rules.

## Payment transaction

The PLAY button authenticates with the existing Mojang session flow and calls `POST /api/payment-transactions` with the integer amount. The backend derives the player from the bearer token, records the configured payment target and amount, and returns a server-generated transaction ID. Only after that record succeeds does the client send the normal Minecraft `/pay <target> <amount>` command. This endpoint does not call `/api/bet` or return a game result or payout.
