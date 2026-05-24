# vidya-steam-bot — Agent Context

TypeScript Steam bot for TF2 giveaway prize delivery. Deployed on Railway via Docker. Node 20+, pnpm, Prisma ORM 7, MySQL.

## Project structure

```
src/
  index.ts               — entrypoint: sets up error handlers, calls startBot()
  bot.ts                 — Steam session bootstrap (startBot, shutdownSteam, prisma export)
  db.ts                  — PrismaClient with MariaDB driver adapter
  env.ts                 — Zod-validated env vars (validated at startup)
  api/
    server.ts            — HTTP API server (Node http, no framework)
  db/
    donations.ts         — Prisma queries for DonationOffer / DonationOfferItem / PrizePoolItem
    pending-deliveries.ts — Prisma queries for PendingDelivery
  services/
    backpack-prices.ts   — backpack.tf price lookups
    claim-chat.ts        — Steam chat for prize claim flow
    delivery.ts          — triggerPrizeDelivery, send trade offer to winner
    donations.ts         — approveDonationOffer, rejectDonationOffer
    friends.ts           — friend request handling
    help-chat.ts         — Steam chat help responses
    offer-lifecycle.ts   — cancelTradeOfferIfActive, offer state machine
    trades.ts            — incoming trade offer handling
  steam/
    confirm.ts           — Steam mobile confirmations
    session.ts           — SteamContext type, session init (steam-user + steamcommunity)
    tf2-inventory.ts     — loadTf2InventoryViaCommunity
  utils/
    discord.ts           — Discord webhook notifications (notify, Colors, steamProfileLink)
    error-handler.ts     — setupErrorHandlers (SIGINT/SIGTERM + uncaught)
    persona.ts           — resolvePersonaName (cached Steam name lookups)
prisma/
  schema.prisma          — DB schema (no url field; url lives in prisma.config.ts)
generated/prisma/        — generated Prisma client (run pnpm db:generate)
scripts/
  backfill-prices.ts     — one-off: backfill backpack.tf prices to prize_pool_items
  reconcile-inventory.ts — one-off: reconcile bot inventory vs DB
  lib/bot-api-inventory.ts — shared helper fetching /inventory from the bot HTTP API
docs/
  steam-giveaway-bot-spec.md
  phased-development-plan.md
```

## Database schema (prisma/schema.prisma)

**`pending_deliveries`** (`PendingDelivery`) — one row per prize to be delivered.
- `winner_steam_id`, `asset_id`, `item_name`, `status` (`pending | offer_sent | delivered | cancelled`)
- `trade_offer_id`, `expires_at`, `last_attempt_at`, `last_failure_code/message`
- `active_reservation_key` — unique, used to deduplicate reservations

**`donation_offers`** (`DonationOffer`) — incoming trade offers from donors.
- `trade_offer_id` (unique), `donor_steam_id/name`, `message`, `status` (`pending_review | approved | rejected | expired | accepted_failed`)
- Relations: `items` (DonationOfferItem[]), `prizePoolItems` (PrizePoolItem[])

**`donation_offer_items`** (`DonationOfferItem`) — per-item snapshot while pending review.
- `app_id`, `context_id`, `asset_id`, `class_id`, `instance_id`, `name`, `icon_url`

**`prize_pool_items`** (`PrizePoolItem`) — approved items in the prize pool.
- `asset_id` (unique), `item_name`, `donor_steam_id/name`, `donation_offer_id`
- `price_keys`, `price_metal`, `price_in_metal`, `priced_at`

## HTTP API (src/api/server.ts)

Auth: `X-Bot-Secret` header or `Authorization: Bearer <token>` (compared via `API_SECRET` env var).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/inventory` | Bot TF2 inventory. `?minimal=1` omits imageUrl. `?includeReserved=1` includes reserved items. Sorted by price descending. |
| GET | `/friend-status/:steamId64` | Returns `{ isFriend: boolean }` |
| POST | `/delivery/trigger` | `{ steamId64 }` — queue delivery for a winner who is already a friend |
| POST | `/delivery/record` | `{ steamId64, assetId, itemName }` — create PendingDelivery, trigger if already friend |
| POST | `/delivery/admin-send` | `{ winnerSteamId, items: [{assetId, itemName}] }` — batch record + trigger |
| GET | `/delivery/active` | List active deliveries with winner names |
| POST | `/delivery/revoke` | `{ assetId, action: 'return_to_pool'|'reassign', targetSteamId?, adminSteamId?, adminName? }` |
| GET | `/donations/pending` | List donation offers with status `pending_review` |
| POST | `/donations/:tradeOfferId/approve` | `{ reviewerSteamId?, reviewerName?, note? }` |
| POST | `/donations/:tradeOfferId/reject` | `{ reviewerSteamId?, reviewerName?, note? }` |

## Environment variables (src/env.ts)

Required: `STEAM_ACCOUNT_NAME`, `STEAM_PASSWORD`, `STEAM_SHARED_SECRET`, `STEAM_IDENTITY_SECRET`, `DATABASE_URL` (MySQL), `API_SECRET`, `BOT_ADMINS` (comma-separated SteamID64).
Optional: `API_PORT` (default 3000), `API_HOST` (default 0.0.0.0), `REMOVE_FRIEND_AFTER_DELIVERY` (default true), `MANUAL_DELIVERY_EXPIRY_DAYS`.

## Key conventions

- Path alias `@/` → `src/`
- `pnpm dev` loads `.env` via `--env-file`; `pnpm start` does not (production: set env in host/container)
- Prisma client output is `generated/prisma/` (not `node_modules`); run `pnpm db:generate` after schema changes
- `prisma.config.ts` holds the datasource URL (Prisma v7 pattern); schema.prisma has no `url` field
- Discord notifications go through `src/utils/discord.ts` → `notify('admin', ...)` or `notify('public', ...)`
- Steam session state persists to `./steam-data/` (mount as volume in Docker)
- Deployed on Railway: `railway.json` sets `builder: DOCKERFILE`; pre-deploy runs `pnpm db:migrate:deploy`
