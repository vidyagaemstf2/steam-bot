# Multi-stage OCI image (build with `podman build` or `docker build`).
# Full `pnpm install` (including devDependencies) so `tsx` and `prisma` CLI stay available —
# matches `pnpm start` and optional one-off `pnpm db:migrate:deploy` in the image.
# For a smaller image later, move `tsx` to dependencies and/or emit compiled JS.

FROM node:20-bookworm-slim AS base
WORKDIR /app
RUN corepack enable pnpm

# Install deps + run postinstall (`prisma generate`). Do not set NODE_ENV=production here or
# devDependencies (e.g. tsx, prisma) would be omitted.
# `prisma.config.ts` resolves DATABASE_URL at config load; no database is contacted during generate.
FROM base AS build
ENV DATABASE_URL="mysql://build:build@127.0.0.1:3306/build"
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
RUN pnpm install --frozen-lockfile

FROM base AS runner
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/generated ./generated
COPY package.json pnpm-lock.yaml ./
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src

EXPOSE 3000
CMD ["pnpm", "start"]
