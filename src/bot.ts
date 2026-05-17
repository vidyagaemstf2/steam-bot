import { startApiServer } from '@/api/server.ts';
import { prisma } from '@/db.ts';
import { cancelExpiredDeliveries } from '@/db/pending-deliveries.ts';
import { env } from '@/env.ts';
import { registerClaimChat } from '@/services/claim-chat.ts';
import { registerOutboundDelivery } from '@/services/delivery.ts';
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

async function runExpirySweep(): Promise<void> {
  try {
    const cancelled = await cancelExpiredDeliveries();
    if (cancelled.length === 0) {
      return;
    }
    console.log(`[bot] Expired ${String(cancelled.length)} unclaimed delivery row(s).`);
    void notify('admin', {
      title: 'Unclaimed deliveries expired',
      description: `${String(cancelled.length)} delivery row(s) were auto-cancelled due to expiry.`,
      color: Colors.Yellow,
      fields: cancelled.map((r) => ({
        name: r.winner_steam_id,
        value: r.item_name,
        inline: true
      }))
    });
  } catch (err) {
    console.error('[bot] Expiry sweep failed:', err);
  }
}

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
      await runExpirySweep();
      setInterval(() => { void runExpirySweep(); }, 60 * 60 * 1000);
      registerFriendGating(steamCtx);
      registerOutboundDelivery(steamCtx);
      registerHelpChat(steamCtx);
      registerClaimChat(steamCtx);
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
