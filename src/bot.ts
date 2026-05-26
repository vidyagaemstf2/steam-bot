import { startApiServer } from '@/api/server.ts';
import { prisma } from '@/db.ts';
import {
  cancelDeliveriesByIds,
  cancelExpiredDeliveries,
  findStaleOfferSentDeliveries
} from '@/db/pending-deliveries.ts';
import { env } from '@/env.ts';
import { registerClaimChat } from '@/services/claim-chat.ts';
import { registerOutboundDelivery } from '@/services/delivery.ts';
import { registerFriendActivity, runInactiveFriendSweep } from '@/services/friend-activity.ts';
import { registerFriendGating } from '@/services/friends.ts';
import { registerHelpChat } from '@/services/help-chat.ts';
import {
  cancelTradeOfferIfActive,
  reconcileOfferSentOnStartup,
  registerOfferLifecycle
} from '@/services/offer-lifecycle.ts';
import {
  reconcilePendingDonationsOnStartup,
  registerIncomingTradePolicy
} from '@/services/trades.ts';
import { connectSteam, getSteamContext, shutdownSteam } from '@/steam/session.ts';
import type { SteamContext } from '@/steam/session.ts';
import { Colors, notify, steamProfileLink } from '@/utils/discord.ts';

export { prisma, getSteamContext, shutdownSteam };

async function runExpirySweep(ctx: SteamContext): Promise<void> {
  try {
    const cancelled = await cancelExpiredDeliveries();
    if (cancelled.length > 0) {
      console.log(`[bot] Expired ${String(cancelled.length)} unclaimed delivery row(s).`);
      void notify('admin', {
        title: 'Unclaimed deliveries expired',
        description: `${String(cancelled.length)} delivery row(s) were auto-cancelled due to expiry.`,
        color: Colors.Yellow,
        fields: cancelled.map((r) => ({
          name: r.item_name,
          value: steamProfileLink(r.winner_steam_id, r.winner_steam_id),
          inline: true
        }))
      });
    }
  } catch (err) {
    console.error('[bot] Pending expiry sweep failed:', err);
  }

  try {
    const stale = await findStaleOfferSentDeliveries();
    if (stale.length === 0) return;

    console.log(`[bot] Found ${String(stale.length)} stale offer_sent delivery row(s) past expiry; cancelling...`);
    for (const row of stale) {
      if (row.trade_offer_id) {
        await cancelTradeOfferIfActive(ctx.tradeOfferManager, row.trade_offer_id);
      }
    }
    await cancelDeliveriesByIds(stale.map((r) => r.id));
    console.log(`[bot] Cancelled ${String(stale.length)} stale offer_sent row(s).`);
    void notify('admin', {
      title: '⏰ Ofertas de premio vencidas canceladas',
      description: `${String(stale.length)} oferta(s) en estado offer_sent fueron canceladas por expiración. Los items fueron devueltos al pool.`,
      color: Colors.Yellow,
      fields: stale.map((r) => ({
        name: r.item_name,
        value: steamProfileLink(r.winner_steam_id, r.winner_steam_id),
        inline: true
      }))
    });
  } catch (err) {
    console.error('[bot] Offer-sent expiry sweep failed:', err);
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
      console.log(`[bot] INACTIVE_FRIEND_PRUNE_DAYS=${String(env.INACTIVE_FRIEND_PRUNE_DAYS)}`);
      console.log(`[bot] STEAM_FRIEND_LIMIT=${String(env.STEAM_FRIEND_LIMIT)} FRIEND_PRUNE_THRESHOLD_PCT=${String(env.FRIEND_PRUNE_THRESHOLD_PCT)}`);
      console.log(`[bot] DATABASE_URL (redacted)=${redactedDatabaseUrl(env.DATABASE_URL)}`);

      const steamCtx = await connectSteam();
      console.log('[bot] Steam session ready.');
      void notify('admin', {
        title: 'Bot online',
        description: 'Steam session established. All services starting.',
        color: Colors.Green,
      });
      await reconcileOfferSentOnStartup(steamCtx);
      await reconcilePendingDonationsOnStartup(steamCtx);
      await runExpirySweep(steamCtx);
      setInterval(() => { void runExpirySweep(steamCtx); }, 60 * 60 * 1000);
      registerFriendActivity(steamCtx);
      setInterval(() => { void runInactiveFriendSweep(steamCtx); }, 60 * 60 * 1000);
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
