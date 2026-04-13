import type TradeOffer from 'steam-tradeoffer-manager/lib/classes/TradeOffer.js';
import TradeOfferManager from 'steam-tradeoffer-manager';
import { isBotAdmin } from '@/env.ts';
import { confirmTradeOfferWithRetries } from '@/steam/confirm.ts';
import type { SteamContext } from '@/steam/session.ts';

function acceptOffer(offer: TradeOffer): Promise<string> {
  return new Promise((resolve, reject) => {
    offer.accept((err, status) => {
      if (err) {
        reject(err);
      } else {
        resolve(status);
      }
    });
  });
}

function declineOffer(offer: TradeOffer): Promise<void> {
  return new Promise((resolve, reject) => {
    offer.decline((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export async function handleIncomingOffer(offer: TradeOffer, ctx: SteamContext): Promise<void> {
  const steamId = offer.partner.getSteamID64();
  const offerId = offer.id ?? 'unknown';

  console.log(`[trades] Incoming offer ${offerId} from ${steamId}`);

  const decline = async (reason: string): Promise<void> => {
    console.log(`[trades] Declining offer ${offerId} from ${steamId}: ${reason}`);
    try {
      await declineOffer(offer);
    } catch (err) {
      console.error(`[trades] Failed to decline offer ${offerId}:`, err);
    }
  };

  if (!isBotAdmin(steamId)) {
    await decline('sender is not in BOT_ADMINS');
    return;
  }

  console.log(`[trades] Accepting offer ${offerId} from admin ${steamId}`);

  try {
    const status = await acceptOffer(offer);
    console.log(`[trades] Offer ${offerId} accepted (status: ${status})`);
  } catch (err) {
    console.error(`[trades] Failed to accept offer ${offerId}:`, err);
    return;
  }

  if (offer.itemsToGive.length > 0) {
    const idForConfirm = offer.id;
    if (idForConfirm === null || idForConfirm === undefined) {
      console.error(`[trades] Offer requires confirmation but has no trade offer id yet`);
      return;
    }
    const idStr = String(idForConfirm);
    try {
      await confirmTradeOfferWithRetries(ctx.community, ctx.identitySecret, idStr, {
        logPrefix: '[trades]'
      });
      console.log(`[trades] Offer ${idStr} confirmed via STEAM_IDENTITY_SECRET`);
    } catch (err) {
      console.error(`[trades] Failed to confirm offer ${idStr}:`, err);
    }
  }
}

let incomingTradePolicyRegistered = false;

function pollActiveReceivedOffers(ctx: SteamContext): void {
  console.log('[trades] Checking for active received offers (e.g. while offline)...');

  ctx.tradeOfferManager.getOffers(
    1,
    (err: Error | null, _sent: unknown[], received: TradeOffer[]) => {
      if (err) {
        console.error('[trades] Failed to fetch active offers:', err.message);
        return;
      }

      const pending = received.filter(
        (o: TradeOffer) => o.state === TradeOfferManager.ETradeOfferState.Active
      );

      if (pending.length === 0) {
        console.log('[trades] No pending received offers');
        return;
      }

      console.log(
        `[trades] Found ${String(pending.length)} pending received offer(s), processing...`
      );
      for (const offer of pending) {
        void handleIncomingOffer(offer, ctx);
      }
    }
  );
}

/**
 * Registers `newOffer` and processes any active received offers once (after cookies are ready).
 * Safe to call once per process; duplicate calls are ignored.
 */
export function registerIncomingTradePolicy(ctx: SteamContext): void {
  if (incomingTradePolicyRegistered) {
    return;
  }
  incomingTradePolicyRegistered = true;

  ctx.tradeOfferManager.on('newOffer', (offer: TradeOffer) => {
    void handleIncomingOffer(offer, ctx);
  });

  pollActiveReceivedOffers(ctx);
}
