import { startApiServer } from '@/api/server.ts';
import { prisma } from '@/db.ts';
import { env } from '@/env.ts';
import { connectSteam, getSteamContext, shutdownSteam } from '@/steam/session.ts';

export { prisma, getSteamContext, shutdownSteam };

function redactedDatabaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return '(could not parse DATABASE_URL for display)';
  }
}

/**
 * Entry point for runtime wiring (mirrors `login()` in the reference steam-bot).
 * Later phases attach HTTP API and trade policy on top of the Steam session.
 */
export function startBot(): void {
  void (async () => {
    try {
      await prisma.$connect();
      console.log('[bot] Database connection OK.');
      console.log(`[bot] API bind=${env.API_HOST}:${String(env.API_PORT)}`);
      console.log(`[bot] BOT_ADMINS count=${String(env.BOT_ADMINS.length)}`);
      console.log(`[bot] REMOVE_FRIEND_AFTER_DELIVERY=${String(env.REMOVE_FRIEND_AFTER_DELIVERY)}`);
      console.log(`[bot] DATABASE_URL (redacted)=${redactedDatabaseUrl(env.DATABASE_URL)}`);

      const steamCtx = await connectSteam();
      console.log('[bot] Steam session ready.');
      await startApiServer(steamCtx);
    } catch (err) {
      console.error('[bot] Startup failed:', err);
      process.exit(1);
    }
  })();
}
