import SteamUser from 'steam-user';
import type TradeOffer from 'steam-tradeoffer-manager/lib/classes/TradeOffer.js';
import TradeOfferManager from 'steam-tradeoffer-manager';
import {
  findRowsByTradeOfferId,
  listOfferSentRowsForWinner,
  markDeliveredByTradeOfferId,
  resetOfferSentToPendingByTradeOfferId
} from '@/db/pending-deliveries.ts';
import { env } from '@/env.ts';
import type { SteamContext } from '@/steam/session.ts';

function getOffer(manager: SteamContext['tradeOfferManager'], id: string): Promise<TradeOffer> {
  return new Promise((resolve, reject) => {
    manager.getOffer(id, (err, offer) => {
      if (err) {
        reject(err);
      } else {
        resolve(offer);
      }
    });
  });
}

function cancelOffer(offer: TradeOffer): Promise<void> {
  return new Promise((resolve, reject) => {
    offer.cancel((err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function handleSentOfferChanged(ctx: SteamContext, offer: TradeOffer): Promise<void> {
  if (!offer.isOurOffer || offer.id === null || offer.id === undefined) {
    return;
  }

  const tid = String(offer.id);
  const tracked = await findRowsByTradeOfferId(tid);
  if (tracked.length === 0) {
    return;
  }

  const S = TradeOfferManager.ETradeOfferState;

  try {
    if (offer.state === S.Accepted) {
      await markDeliveredByTradeOfferId(tid);
      console.log(
        `[offer-lifecycle] Offer ${tid} accepted; marked delivered (${String(tracked.length)} row(s))`
      );
      if (env.REMOVE_FRIEND_AFTER_DELIVERY) {
        try {
          ctx.user.removeFriend(offer.partner);
          console.log(`[offer-lifecycle] removeFriend after delivery for offer ${tid}`);
        } catch (err) {
          console.error(
            `[offer-lifecycle] removeFriend after delivery failed for offer ${tid}:`,
            err
          );
        }
      }
      return;
    }

    if (
      offer.state === S.Declined ||
      offer.state === S.Expired ||
      offer.state === S.Canceled ||
      offer.state === S.InvalidItems ||
      offer.state === S.CanceledBySecondFactor ||
      offer.state === S.Countered
    ) {
      if (offer.state === S.InvalidItems) {
        console.error(
          `[offer-lifecycle] Offer ${tid} InvalidItems; items no longer valid — not marking delivered, resetting to pending`
        );
      } else {
        console.log(
          `[offer-lifecycle] Offer ${tid} ended (state=${String(offer.state)}); resetting to pending`
        );
      }
      await resetOfferSentToPendingByTradeOfferId(tid);
    }
  } catch (err) {
    console.error(`[offer-lifecycle] Error handling sent offer ${tid}:`, err);
  }
}

async function handlePartnerUnfriended(ctx: SteamContext, partnerId64: string): Promise<void> {
  const rows = await listOfferSentRowsForWinner(partnerId64);
  if (rows.length === 0) {
    return;
  }

  const tradeOfferIds = [
    ...new Set(
      rows.map((r) => r.trade_offer_id).filter((x): x is string => x !== null && x.length > 0)
    )
  ];

  for (const tradeOfferId of tradeOfferIds) {
    try {
      const offer = await getOffer(ctx.tradeOfferManager, tradeOfferId);
      const S = TradeOfferManager.ETradeOfferState;
      if (
        offer.state === S.Active ||
        offer.state === S.CreatedNeedsConfirmation ||
        offer.state === S.InEscrow
      ) {
        try {
          await cancelOffer(offer);
          console.log(
            `[offer-lifecycle] Cancelled offer ${tradeOfferId} after partner ${partnerId64} unfriended`
          );
        } catch (err) {
          console.error(`[offer-lifecycle] cancel offer ${tradeOfferId} on unfriend:`, err);
        }
      }
    } catch (err) {
      console.error(`[offer-lifecycle] getOffer ${tradeOfferId} on unfriend:`, err);
    }

    try {
      await resetOfferSentToPendingByTradeOfferId(tradeOfferId);
      console.log(
        `[offer-lifecycle] Reset offer_sent to pending for trade_offer_id=${tradeOfferId} (unfriend)`
      );
    } catch (err) {
      console.error(`[offer-lifecycle] reset after unfriend for ${tradeOfferId}:`, err);
    }
  }
}

let offerLifecycleRegistered = false;

/**
 * Tracks outbound giveaway offers: sentOfferChanged → DB; unfriend → cancel + reset.
 * Safe to call once per process.
 */
export function registerOfferLifecycle(ctx: SteamContext): void {
  if (offerLifecycleRegistered) {
    return;
  }
  offerLifecycleRegistered = true;

  ctx.tradeOfferManager.on('sentOfferChanged', (offer) => {
    void handleSentOfferChanged(ctx, offer);
  });

  ctx.user.on('friendRelationship', (steamId, relationship) => {
    if (relationship !== SteamUser.EFriendRelationship.None) {
      return;
    }
    const partnerId64 = steamId.getSteamID64();
    void handlePartnerUnfriended(ctx, partnerId64).catch((err: unknown) => {
      console.error(`[offer-lifecycle] handlePartnerUnfriended failed for ${partnerId64}:`, err);
    });
  });
}
