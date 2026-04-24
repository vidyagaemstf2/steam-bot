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
      .transform((v) => v === 'true')
  },
  runtimeEnv,
  emptyStringAsUndefined: true
});

export function isBotAdmin(steamId64Str: string): boolean {
  return env.BOT_ADMINS.includes(steamId64Str);
}
