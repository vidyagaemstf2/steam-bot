# vidya-steam-bot

TypeScript Steam bot for TF2 giveaway prize delivery. See [docs/steam-giveaway-bot-spec.md](./docs/steam-giveaway-bot-spec.md) and [docs/phased-development-plan.md](./docs/phased-development-plan.md).

## Prerequisites

- Node.js 20+
- [pnpm](https://pnpm.io/)

## Setup

```bash
pnpm install
cp .env.example .env
# Edit .env with real values (never commit .env)
```

## Scripts

| Command          | Description                                                         |
| ---------------- | ------------------------------------------------------------------- |
| `pnpm dev`       | Run with `.env` loaded (local development)                          |
| `pnpm start`     | Run without auto-loading `.env` (set env vars in the shell or host) |
| `pnpm typecheck` | TypeScript `--noEmit`                                               |
| `pnpm lint`      | ESLint on `src/`                                                    |
| `pnpm format`    | Prettier write                                                      |

## P0 behavior

The process validates configuration at startup, prints a **non-secret** summary (API port, admin count, redacted database URL), then stays running until **SIGINT** / **SIGTERM** (e.g. Ctrl+C). Steam integration begins in phase P2.
