# Steam Giveaway Bot — Technical Specification

## 1. Overview

A TypeScript Steam bot that integrates with the `sm-giveaways` SourceMod plugin via a bridge SM plugin (`giveaways_bot.sp`) and a shared **MySQL** database. SourceMod’s database drivers are geared toward MySQL (and SQLite), not PostgreSQL, so the bridge plugin and the bot must use the same MySQL instance and schema. The bot's responsibilities are purely Steam-side: managing its inventory, detecting pending deliveries when players add it, and sending trade offers automatically.

---

## 2. Architecture

```
[giveaways_bot.sp]  ──HTTP──▶  [Steam Bot HTTP API]   (inventory query only)
[giveaways_bot.sp]  ──SQL──▶   [Database]              (write pending deliveries)
[Steam Bot]         ──SQL──▶   [Database]              (read & update deliveries)
[Steam Bot]         ◀──────▶   [Steam Network]         (friend requests, trade offers)
```

Two components need to be built:

| Component          | Language   | Role                                                                      |
| ------------------ | ---------- | ------------------------------------------------------------------------- |
| `giveaways_bot.sp` | SourcePawn | Bridge plugin; hooks giveaway events, queries bot inventory, writes to DB |
| Steam Bot          | TypeScript | Monitors DB for pending deliveries, handles all Steam trade logic         |

---

## 3. Roles

### Bot Admin

A SteamID64 listed in the bot's environment configuration. Any incoming trade offer from an admin is **auto-accepted unconditionally** — this is how items are added to or taken from the bot outside of giveaways.

### Player

Any Steam user. The only trade the bot ever initiates toward a player is delivering a prize they won. Incoming offers from non-admins are auto-declined.

> Giveaway start authorization is handled entirely by SourceMod's admin system (`ADMFLAG_GENERIC` on `sm_gstart`). The bot does not need to know or care about who is allowed to start giveaways.

---

## 4. `giveaways_bot.sp` — Bridge Plugin

This SourceMod plugin depends on `giveaways.inc` and acts as the glue between the game server and the rest of the system.

### 4.1 Overriding `sm_gstart`

`giveaways_bot.sp` intercepts `sm_gstart` by hooking `Giveaways_OnGiveawayStart` and returning `Plugin_Handled` to block the original flow. It then shows the inventory menu, and once the admin selects an item, re-fires `sm_gstart` via `FakeClientCommand` with the properly formatted prize string.

To avoid an infinite loop (the re-fired command triggers the same forward again), the plugin uses a boolean flag `g_bBotInitiated` that is set to `true` just before the re-fire and cleared inside the forward on the next call.

Flow:

1. Admin runs `sm_gstart` (no args needed).
2. `Giveaways_OnGiveawayStart` fires — plugin blocks it and calls `GET /inventory` on the bot's HTTP API.
3. Plugin displays the item list as an in-game menu.
4. Admin selects one item.
5. Plugin sets `g_bBotInitiated = true` and calls `FakeClientCommand(client, "sm_gstart <prize>")`, where the prize string encodes both the display name and the assetId:
   ```
   Mann Co. Supply Crate #85|123456789
   ```
6. `Giveaways_OnGiveawayStart` fires again — plugin sees `g_bBotInitiated == true`, clears the flag, and returns `Plugin_Continue` to let the giveaway proceed normally.

The display name portion is used by `sm-giveaways` for in-game announcements. The assetId (after `|`) is parsed back by `giveaways_bot.sp` when the giveaway ends.

No modifications to the main plugin are required.

### 4.2 Hooked Forwards

**`Giveaways_OnGiveawayEnded(int creator, int winner, int participants, const char[] prize)`**

This is the only forward that matters for the bot integration.

- Resolves `winner` client index → SteamID64 via `GetClientAuthId(winner, AuthId_SteamID64, ...)`.
- Parses `prize` to extract `itemName` and `assetId` (split on `|`).
- Inserts a row into `pending_deliveries` with `status = 'pending'`.
- Announces in chat to the winner: _"Congratulations! Add [bot Steam URL] to receive your prize."_

> Note: `winner` is `0` when the giveaway ends with no participants. The plugin must guard against this before writing to DB.

**Other forwards** (`OnGiveawayStart`, `OnClientEnter`, `OnClientLeave`, `OnGiveawayCancel`) — not needed for bot integration. Return `Plugin_Continue` on all of them or simply don't hook them.

### 4.3 Database Access

The plugin writes directly to the shared **MySQL** database using SourceMod's SQL natives, configured via the `giveaways_bot` entry in `databases.cfg` (MySQL driver / connection string as required by your server setup).

---

## 5. Steam Bot HTTP API (Internal)

The bot exposes a minimal HTTP server **only** so `giveaways_bot.sp` can query available inventory before a giveaway starts. It should be bound to localhost or a private network interface only.

### `GET /inventory`

Returns the bot's current tradable TF2 inventory, excluding items already associated with a `pending` or `offer_sent` delivery record.

**Auth:** Shared secret header — `X-Bot-Secret: <value>`, set in both the bot's environment and the bridge plugin's config.

**Response:**

```json
[
  {
    "assetId": "123456789",
    "name": "Mann Co. Supply Crate #85",
    "imageUrl": "https://..."
  }
]
```

---

## 6. Database Schema

The persistence layer is **MySQL** so both SourceMod and the TypeScript bot can use identical DDL and types.

### `pending_deliveries`

| Column            | Type       | Notes                                             |
| ----------------- | ---------- | ------------------------------------------------- |
| `id`              | integer PK | Auto-increment                                    |
| `winner_steam_id` | varchar    | SteamID64 of the winner                           |
| `asset_id`        | varchar    | Steam assetId of the item to deliver              |
| `item_name`       | varchar    | Human-readable name, for display/logging          |
| `status`          | enum       | `pending`, `offer_sent`, `delivered`, `cancelled` |
| `created_at`      | timestamp  |                                                   |
| `delivered_at`    | timestamp  | Nullable; set when trade confirmed accepted       |
| `trade_offer_id`  | varchar    | Nullable; set when bot sends the offer            |

---

## 7. Delivery Flow (Steam Bot)

```
[Player adds the bot on Steam]
        ↓
[Bot queries DB: any rows for this SteamID64 with status = 'pending'?]
        ├── NO  → Decline friend request
        └── YES → Accept friend request
                        ↓
              [Bot sends a single trade offer with all pending items]
              [Sets trade_offer_id, status = 'offer_sent' in DB]
                        ↓
              [Bot monitors trade offer state]
                        ├── Accepted → status = 'delivered', delivered_at = now()
                        │             Optionally remove player from friends list
                        └── Declined / Expired → status reset to 'pending'
```

---

## 8. Trade Offer Rules

| Direction               | Sender                         | Rule                        |
| ----------------------- | ------------------------------ | --------------------------- |
| Incoming (player → bot) | Admin SteamID64                | Auto-accept unconditionally |
| Incoming (player → bot) | Anyone else                    | Auto-decline                |
| Outgoing (bot → player) | Winner with `pending` delivery | Auto-send on friend add     |

The bot never initiates trades for any reason other than delivering a pending prize.

---

## 9. Startup Reconciliation

On startup, the bot should:

1. Fetch all rows with `status = 'offer_sent'` from the DB.
2. Check the actual state of each `trade_offer_id` against the Steam API.
3. Accepted → mark `delivered`.
4. Cancelled/expired → reset to `pending`.
5. Still active → resume monitoring normally.

---

## 10. Configuration (environment variables)

The Steam bot loads all settings from **environment variables** (e.g. a **`.env` file in local development**, loaded via `node --env-file=.env` or similar — the real `.env` must stay **gitignored**). Production uses the same variable names set in the host or platform (Railway, VPS, etc.). **Do not commit secrets.** The implementation should validate required variables at startup (e.g. with Zod).

| Variable                       | Required | Description                                                                                                                                                                                                                                    |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STEAM_ACCOUNT_NAME`           | yes      | Bot Steam login                                                                                                                                                                                                                                |
| `STEAM_PASSWORD`               | yes      | Bot Steam password                                                                                                                                                                                                                             |
| `STEAM_SHARED_SECRET`          | yes      | Steam Guard shared secret (e.g. from `.maFile`)                                                                                                                                                                                                |
| `STEAM_IDENTITY_SECRET`        | yes      | Mobile confirmations secret (trade confirmations)                                                                                                                                                                                              |
| `DATABASE_URL`                 | yes      | MySQL connection URL (e.g. `mysql://user:pass@host:3306/dbname` for Prisma). For local development you can point this at a throwaway MySQL instance (e.g. Podman as in the phased development plan); for production, use your real MySQL host. |
| `API_PORT`                     | no       | Port for the internal HTTP API (default e.g. `3000`)                                                                                                                                                                                           |
| `API_SECRET`                   | yes      | Shared secret for `X-Bot-Secret` (must match the bridge plugin)                                                                                                                                                                                |
| `BOT_ADMINS`                   | yes      | Comma-separated SteamID64 list; those users get unconditional incoming trade acceptance                                                                                                                                                        |
| `REMOVE_FRIEND_AFTER_DELIVERY` | no       | `true` / `false` — whether to remove the winner from the friends list after a successful delivery                                                                                                                                              |

Example `.env.example` (committed; no real secrets):

```bash
STEAM_ACCOUNT_NAME=
STEAM_PASSWORD=
STEAM_SHARED_SECRET=
STEAM_IDENTITY_SECRET=
DATABASE_URL=mysql://user:pass@host:3306/dbname
API_PORT=3000
API_SECRET=shared-secret-with-sm-plugin
BOT_ADMINS=76561198000000000
REMOVE_FRIEND_AFTER_DELIVERY=true
```

---

## 11. Edge Cases

| Scenario                                  | Behavior                                                   |
| ----------------------------------------- | ---------------------------------------------------------- |
| Giveaway ends with no participants        | `winner` is `0` in the forward — plugin must skip DB write |
| Player never adds the bot                 | Delivery stays `pending` indefinitely                      |
| Player declines the trade offer           | Reset to `pending`; bot retries on next friend add         |
| Bot restarts mid-offer                    | Startup reconciliation (section 9) handles this            |
| Item no longer in bot's inventory         | Log error, do not mark as delivered                        |
| Player has multiple pending deliveries    | Single trade offer containing all pending items            |
| Player removes bot before trade completes | Cancel offer, reset to `pending`                           |

---

## 12. Out of Scope

- Web dashboard or admin UI
- Multiple concurrent giveaways (enforced by `sm-giveaways` itself)
- Multi-server support
- Automatic/scheduled giveaways
- Multiple winners per giveaway
