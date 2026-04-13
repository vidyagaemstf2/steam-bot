import { startApiServer } from '@/api/server.ts';
import { prisma } from '@/db.ts';
import { env } from '@/env.ts';
import { registerOutboundDelivery } from '@/services/delivery.ts';
import { registerFriendGating } from '@/services/friends.ts';
import { registerIncomingTradePolicy } from '@/services/trades.ts';
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
 * Attaches HTTP API, friend gating, incoming trades, outbound delivery, after Steam is ready.
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
      registerFriendGating(steamCtx);
      registerOutboundDelivery(steamCtx);
      registerIncomingTradePolicy(steamCtx);
      await startApiServer(steamCtx);
    } catch (err) {
      console.error('[bot] Startup failed:', err);
      process.exit(1);
    }
  })();
}
