import { startApiServer } from '@/api/server.ts';
import { prisma } from '@/db.ts';
import { env } from '@/env.ts';
import { registerClaimChat } from '@/services/claim-chat.ts';
import { registerOutboundDelivery } from '@/services/delivery.ts';
import { registerDonationChat } from '@/services/donations.ts';
import { registerFriendGating } from '@/services/friends.ts';
import { registerHelpChat } from '@/services/help-chat.ts';
import {
  reconcileOfferSentOnStartup,
  registerOfferLifecycle
} from '@/services/offer-lifecycle.ts';
import { registerIncomingTradePolicy } from '@/services/trades.ts';
import { connectSteam, getSteamContext, shutdownSteam } from '@/steam/session.ts';
import { Colors, notify } from '@/utils/discord.ts';

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
 * Attaches HTTP API, friend gating, outbound delivery, offer lifecycle, incoming trades, after Steam is ready.
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
      void notify('admin', {
        title: 'Bot online',
        description: 'Steam session established. All services starting.',
        color: Colors.Green,
      });
      await reconcileOfferSentOnStartup(steamCtx);
      registerFriendGating(steamCtx);
      registerOutboundDelivery(steamCtx);
      registerHelpChat(steamCtx);
      registerClaimChat(steamCtx);
      registerDonationChat(steamCtx);
      registerOfferLifecycle(steamCtx);
      registerIncomingTradePolicy(steamCtx);
      await startApiServer(steamCtx);
    } catch (err) {
      console.error('[bot] Startup failed:', err);
      await notify('admin', {
        title: 'Bot startup failed',
        description: err instanceof Error ? err.message : String(err),
        color: Colors.Red,
      });
      process.exit(1);
    }
  })();
}
