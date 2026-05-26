import { createEnv } from '@t3-oss/env-core';
import { z } from 'zod';

const steamId64 = z.string().regex(/^[0-9]{17}$/, 'Expected SteamID64 (17 digits)');
const runtimeEnv = {
  ...process.env,
  API_PORT: process.env.API_PORT ?? process.env.PORT
};

export const env = createEnv({
  server: {
    STEAM_ACCOUNT_NAME: z.string().min(1, 'STEAM_ACCOUNT_NAME is required'),
    STEAM_PASSWORD: z.string().min(1, 'STEAM_PASSWORD is required'),
    STEAM_SHARED_SECRET: z.string().min(1, 'STEAM_SHARED_SECRET is required'),
    STEAM_IDENTITY_SECRET: z.string().min(1, 'STEAM_IDENTITY_SECRET is required'),
    DATABASE_URL: z.string().url('DATABASE_URL must be a valid URL'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Listen address (`0.0.0.0` = all interfaces; use `127.0.0.1` for local-only). */
    API_HOST: z.string().min(1).default('0.0.0.0'),
    /** API key: send as `X-Bot-Secret` or `Authorization: Bearer <API_SECRET>`. */
    API_SECRET: z.string().min(1, 'API_SECRET is required'),
    BOT_ADMINS: z
      .string()
      .min(1, 'BOT_ADMINS is required')
      .transform((val) =>
        val
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      )
      .pipe(z.array(steamId64).min(1, 'BOT_ADMINS must list at least one SteamID64')),
    REMOVE_FRIEND_AFTER_DELIVERY: z
      .enum(['true', 'false'])
      .optional()
      .default('true')
      .transform((v) => v === 'true'),
    /** Discord webhook URL for the private admin/ops channel. */
    DISCORD_WEBHOOK_ADMIN: z.string().url().optional(),
    /** Discord webhook URL for the public donations announcement channel. */
    DISCORD_WEBHOOK_DONATIONS: z.string().url().optional(),
    /** Days before an admin-initiated unclaimed delivery is auto-cancelled. */
    MANUAL_DELIVERY_EXPIRY_DAYS: z.coerce.number().int().min(1).default(7),
    /**
     * Friends with no interaction in this many days are automatically removed.
     * Set to 0 to disable the sweep entirely.
     */
    INACTIVE_FRIEND_PRUNE_DAYS: z.coerce.number().int().min(0).default(30),
    /** Steam friend list capacity for this account (base limit is 250). */
    STEAM_FRIEND_LIMIT: z.coerce.number().int().min(1).default(250),
    /**
     * Percentage of `STEAM_FRIEND_LIMIT` at which the inactive-friend sweep activates.
     * E.g. 80 means the sweep runs only when the friend list is at least 80 % full.
     */
    FRIEND_PRUNE_THRESHOLD_PCT: z.coerce.number().int().min(1).max(100).default(80),
    /** backpack.tf WebAPI key for item pricing (optional; pricing is skipped when absent). */
    BACKPACK_TF_API_KEY: z.string().min(1).optional()
  },
  runtimeEnv,
  emptyStringAsUndefined: true
});

export function isBotAdmin(steamId64Str: string): boolean {
  return env.BOT_ADMINS.includes(steamId64Str);
}
