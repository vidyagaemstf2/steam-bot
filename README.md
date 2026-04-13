# vidya-steam-bot

TypeScript Steam bot for TF2 giveaway prize delivery. See [docs/steam-giveaway-bot-spec.md](./docs/steam-giveaway-bot-spec.md) and [docs/phased-development-plan.md](./docs/phased-development-plan.md).

## Prerequisites

- Node.js **20.19+** (required by [Prisma ORM 7](https://www.prisma.io/docs/orm/more/upgrade-guides/upgrading-versions/upgrading-to-prisma-7))
- [pnpm](https://pnpm.io/)
- **MySQL** (shared with the SourceMod bridge plugin in production). For a **persistent local database on Windows** (Podman volume + auto-restart), use [scripts/podman-mysql.ps1](./scripts/podman-mysql.ps1). More background: [phased-development-plan.md](./docs/phased-development-plan.md) (Prerequisites).

## Setup

```bash
pnpm install
cp .env.example .env
# Edit .env with real values (never commit .env)
```

Set `DATABASE_URL` to a MySQL URL, e.g. `mysql://user:password@127.0.0.1:3306/your_database`.

### Local MySQL with Podman (persistent)

1. Install [Podman](https://podman.io/) and ensure `podman machine` is running (on Windows/macOS).
2. Optional: copy [scripts/podman-mysql.env.example](./scripts/podman-mysql.env.example) to `scripts/podman-mysql.env` and edit passwords/port.
3. Run:

   ```powershell
   pwsh -File scripts/podman-mysql.ps1
   ```

   This creates volume `vidya-mysql-data`, container **`vidya-mysql`** with **`--restart unless-stopped`**, and prints a `DATABASE_URL` you can paste into `.env`.

4. Apply migrations: `pnpm db:migrate:deploy`

To stop without deleting data: `podman stop vidya-mysql`. To wipe data: `podman rm -f vidya-mysql` then `podman volume rm vidya-mysql-data` (destructive).

## Database (Prisma ORM 7)

- **CLI config:** [prisma.config.ts](./prisma.config.ts) holds the datasource URL (`DATABASE_URL`) for `prisma migrate`, `prisma db execute`, etc. Prisma v7 loads env via **`dotenv`** in that config file. The app entrypoint matches the reference steam-bot layout: [src/index.ts](./src/index.ts) → [src/utils/error-handler.ts](./src/utils/error-handler.ts) → [src/bot.ts](./src/bot.ts) (`startBot()`, analogous to `login()` there). Use `pnpm dev` (`--env-file=.env`) or export vars for `pnpm start`, same as the reference bot.
- **Schema:** [prisma/schema.prisma](./prisma/schema.prisma) — the datasource block has **no** `url` field (URLs live in `prisma.config.ts`).
- **Generated client:** output is [generated/prisma](./generated/prisma/) (not under `node_modules`). Run `pnpm db:generate` after schema changes (also runs on `pnpm install` via `postinstall`).
- **Runtime:** [src/db.ts](./src/db.ts) constructs `PrismaClient` with the **MySQL/MariaDB driver adapter** (`@prisma/adapter-mariadb`) and your `DATABASE_URL` connection string (direct TCP).

| Command                  | Description                                                                                                                      |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm db:generate`       | `prisma generate` → refresh `generated/prisma`                                                                                   |
| `pnpm db:migrate`        | `prisma generate` then `prisma migrate dev` (v7 does **not** auto-run `generate` during migrate — scripts chain them explicitly) |
| `pnpm db:migrate:deploy` | `prisma generate` then `prisma migrate deploy` — for CI/production                                                               |
| `pnpm db:studio`         | [Prisma Studio](https://www.prisma.io/studio)                                                                                    |

After pointing `DATABASE_URL` at an **empty** MySQL database, run `pnpm db:migrate:deploy` to apply all migrations. For day-to-day schema work, use `pnpm db:migrate` locally.

**Hosted MySQL:** You can swap the Podman/local instance for any MySQL 8–compatible host; only connection settings change.

### P1 manual verification

With migrations applied, confirm the table and enum (MySQL client, Prisma Studio, or any SQL tool):

```sql
INSERT INTO pending_deliveries
  (winner_steam_id, asset_id, item_name, status)
VALUES
  ('76561198000000000', '123456789', 'Test Item', 'pending');

SELECT id, winner_steam_id, asset_id, item_name, status, created_at, delivered_at, trade_offer_id
FROM pending_deliveries;
```

You can repeat with `status` values `offer_sent`, `delivered`, and `cancelled` (one row each or `UPDATE` the same row) to satisfy the P1 checklist.

## Scripts

| Command          | Description                                                         |
| ---------------- | ------------------------------------------------------------------- |
| `pnpm dev`       | Run with `.env` loaded (local development)                          |
| `pnpm start`     | Run without auto-loading `.env` (set env vars in the shell or host) |
| `pnpm typecheck` | TypeScript `--noEmit`                                               |
| `pnpm lint`      | ESLint on `src/` and `prisma.config.ts`                             |
| `pnpm format`    | Prettier write                                                      |

## P0 / P1 runtime behavior

Same control flow as the reference **steam-bot**: global error handlers, startup log from `index.ts`, then `startBot()` in `bot.ts` (where Steam/trade logic will live from phase P2). Prisma connects and prints a non-secret summary; the process stays up until **SIGINT** / **SIGTERM** (`setupErrorHandlers` calls `prisma.$disconnect()` on shutdown). Until Steam is wired, a no-op interval keeps the Node event loop alive (the reference bot stays up via `steam-user` instead).
