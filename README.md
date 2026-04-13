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

### Running the bot locally

- **`pnpm dev`** — loads variables from `.env` via Node’s `--env-file=.env`.
- **`pnpm start`** — does **not** load `.env`; set variables in the shell or in the process manager / container environment (same as production).

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

### Database migrations in a container / production

Apply migrations whenever the schema changes, using the same `DATABASE_URL` the app will use:

```bash
# From the repo, with DATABASE_URL set (not committed):
pnpm db:migrate:deploy
```

One-off against a container image (same env file as runtime), using [Podman](https://podman.io/):

```bash
podman run --rm --env-file .env vidya-steam-bot:latest pnpm db:migrate:deploy
```

Migrations are idempotent. Prefer running them as a **release step** (CI, [Railway pre-deploy command](https://docs.railway.com/deployments/pre-deploy-command), or manual) rather than baking automatic `migrate deploy` into the default container entrypoint, unless you explicitly want the bot to migrate on every start (requires DB reachable at startup).

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

## Container image (Podman)

The multi-stage [Dockerfile](./Dockerfile) builds a standard **OCI** image (the filename is conventional; Podman uses it as-is). It targets **Node 20** (`bookworm-slim`) and **`pnpm install --frozen-lockfile` without `--prod`** so **devDependencies** stay installed. That keeps **`tsx`** (runtime TypeScript) and the **`prisma`** CLI available for `pnpm start` and optional `pnpm db:migrate:deploy` inside the image. For a smaller image later, you could move `tsx` to `dependencies` and/or compile to JavaScript.

Examples below use **`podman`**; if you use Docker instead, substitute `docker` — the flags are the same for these commands.

**Build:**

```bash
podman build -t vidya-steam-bot:latest .
```

**Run** (set real secrets via `--env-file` or `-e`; never commit `.env`):

```bash
podman run --name vidya-steam-bot \
  --env-file .env \
  -v vidya-steam-data:/app/steam-data \
  -p 3000:3000 \
  vidya-steam-bot:latest
```

The Steam client persists login keys under **`./steam-data`** relative to the app root ([`src/steam/session.ts`](./src/steam/session.ts)). In the container that is **`/app/steam-data`**. Mount a **named or host volume** there so restarts and redeploys do not force a full Steam re-login. See **Production environment variables** for every required setting.

## Production environment variables (spec §10)

Validated at startup in [`src/env.ts`](./src/env.ts). Full descriptions: [docs/steam-giveaway-bot-spec.md §10](./docs/steam-giveaway-bot-spec.md).

| Variable                       | Required | Default   | Notes                                                                              |
| ------------------------------ | -------- | --------- | ---------------------------------------------------------------------------------- |
| `STEAM_ACCOUNT_NAME`           | yes      | —         | Bot Steam login                                                                    |
| `STEAM_PASSWORD`               | yes      | —         | Bot password                                                                       |
| `STEAM_SHARED_SECRET`          | yes      | —         | Steam Guard shared secret (e.g. from `.maFile`)                                    |
| `STEAM_IDENTITY_SECRET`        | yes      | —         | Mobile confirmation secret                                                         |
| `DATABASE_URL`                 | yes      | —         | MySQL URL for Prisma                                                               |
| `API_SECRET`                   | yes      | —         | `X-Bot-Secret` or `Authorization: Bearer` for HTTP API                             |
| `BOT_ADMINS`                   | yes      | —         | Comma-separated **SteamID64** list (incoming trades from these users are accepted) |
| `API_PORT`                     | no       | `3000`    | HTTP listen port                                                                   |
| `API_HOST`                     | no       | `0.0.0.0` | Bind address (`127.0.0.1` for local-only)                                          |
| `REMOVE_FRIEND_AFTER_DELIVERY` | no       | `true`    | `true` / `false`                                                                   |

## Railway

This repo includes [`railway.json`](./railway.json) with `"builder": "DOCKERFILE"` and `"dockerfilePath": "Dockerfile"`. [Config as code](https://docs.railway.com/reference/config-as-code) overrides dashboard defaults for that deployment.

**Checklist:**

- **MySQL:** Add a Railway MySQL plugin or an external MySQL URL; set **`DATABASE_URL`** accordingly.
- **Secrets:** Set every variable from the table above in the service variables (do not commit secrets).
- **Steam session:** Add a [volume](https://docs.railway.com/reference/volumes) mounted at **`/app/steam-data`** so Steam login data survives restarts.
- **HTTP port:** The app reads **`API_PORT`**, not `PORT`. Many platforms set **`PORT`** for routing. Set **`API_PORT`** to the same value as Railway’s assigned port (e.g. reference the `PORT` variable in the Railway UI, or set both explicitly).
- **Migrations:** Either run **`pnpm db:migrate:deploy`** once per deploy (CLI, CI, or [pre-deploy command](https://docs.railway.com/deployments/pre-deploy-command), e.g. `["pnpm", "db:migrate:deploy"]`), or add a `deploy.preDeployCommand` in `railway.json` if you want it in-repo (requires `DATABASE_URL` during pre-deploy).

## Scripts

| Command                  | Description                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`               | Run with `.env` loaded (local development)                                                                               |
| `pnpm start`             | Run without auto-loading `.env` (set env vars in the shell or host)                                                      |
| `pnpm db:migrate:deploy` | `prisma generate` + `prisma migrate deploy` (CI / production DB)                                                         |
| `pnpm db:smoke`          | Integration smoke for [`src/db/pending-deliveries.ts`](./src/db/pending-deliveries.ts) (needs full env + `DATABASE_URL`) |
| `pnpm typecheck`         | TypeScript `--noEmit`                                                                                                    |
| `pnpm lint`              | ESLint on `src/` and `prisma.config.ts`                                                                                  |
| `pnpm format`            | Prettier write                                                                                                           |

## Smoke and staging checks

Use these after deploy or when validating a staging environment (see [phased-development-plan.md](./docs/phased-development-plan.md) P11):

1. **Database layer:** `pnpm db:smoke` — exercises pending-delivery queries and writes (cleans up test rows).
2. **HTTP API:** With the bot running and secrets configured, call inventory (replace host, port, and secret):

   ```bash
   curl -sS -H "X-Bot-Secret: YOUR_API_SECRET" "http://127.0.0.1:3000/inventory"
   ```

   Wrong or missing secret must return **401** without leaking details; a correct secret returns a JSON array (possibly empty).

3. **Steam:** Confirm logs show successful login and trade manager ready after `webSession`.
4. **Trades:** Run one controlled path — e.g. incoming offer from a **BOT_ADMINS** account accepted, or an outbound delivery test per your P7–P9 setup.

## P0 / P1 runtime behavior

Same control flow as the reference **steam-bot**: global error handlers, startup log from `index.ts`, then `startBot()` in `bot.ts` (where Steam/trade logic will live from phase P2). Prisma connects and prints a non-secret summary; the process stays up until **SIGINT** / **SIGTERM** (`setupErrorHandlers` calls `prisma.$disconnect()` on shutdown). Until Steam is wired, a no-op interval keeps the Node event loop alive (the reference bot stays up via `steam-user` instead).
