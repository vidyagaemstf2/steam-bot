import SteamUser from 'steam-user';
import type TradeOffer from 'steam-tradeoffer-manager/lib/classes/TradeOffer.js';
import TradeOfferManager from 'steam-tradeoffer-manager';
import {
  cancelDeliveriesByTradeOfferId,
  findRowsByTradeOfferId,
  listOfferSentRows,
  listOfferSentRowsForWinner,
  markDeliveredByTradeOfferId,
  resetOfferSentToPendingByTradeOfferId
} from '@/db/pending-deliveries.ts';
import { deletePrizePoolItemsByAssetIds } from '@/db/donations.ts';
import { env } from '@/env.ts';
import type { SteamContext } from '@/steam/session.ts';
import { Colors, notify, steamProfileLink } from '@/utils/discord.ts';
import { resolvePersonaName } from '@/utils/persona.ts';

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

/**
 * Applies DB transitions for an outbound offer we track, given Steam's current state.
 * Used by sentOfferChanged and startup reconciliation (spec §9).
 */
async function applyOutboundOfferStateFromSteam(ctx: SteamContext, offer: TradeOffer): Promise<void> {
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
      const deliveredAssetIds = tracked.map((r) => r.asset_id);
      try {
        const deleted = await deletePrizePoolItemsByAssetIds(deliveredAssetIds);
        console.log(
          `[offer-lifecycle] Removed ${String(deleted)} prize_pool_items row(s) for delivered offer ${tid}`
        );
      } catch (err) {
        console.error(
          `[offer-lifecycle] Failed to remove prize_pool_items for delivered offer ${tid}:`,
          err
        );
      }
      const winnerId = tracked[0]?.winner_steam_id ?? offer.partner.getSteamID64();
      const winnerLabel = await resolvePersonaName(ctx, winnerId);
      const deliveredItems = tracked.map((r) => `• ${r.item_name}`).join('\n') || '—';
      void notify('admin', {
        title: '✅ Premio entregado',
        description: `La oferta a **${steamProfileLink(winnerLabel, winnerId)}** fue aceptada. ${String(tracked.length)} fila(s) marcadas como entregadas.`,
        color: Colors.Green,
        fields: [{ name: '🎮 Items', value: deliveredItems }],
      });
      void notify('donations', {
        title: '🏆 ¡Hay un ganador!',
        description: `¡Felicitaciones **${steamProfileLink(winnerLabel, winnerId)}** por recibir ${String(tracked.length)} premio(s) del sorteo! 🎉`,
        color: Colors.Green,
        fields: [{ name: '🎮 Premio(s)', value: deliveredItems }],
      });
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

    if (offer.state === S.Declined || offer.state === S.Countered) {
      const declinedWinnerId = tracked[0]?.winner_steam_id ?? offer.partner.getSteamID64();
      const declinedWinnerLabel = await resolvePersonaName(ctx, declinedWinnerId);
      const declinedItems = tracked.map((r) => `• ${r.item_name}`).join('\n') || '—';
      const stateLabel = offer.state === S.Countered ? 'contrarrestada' : 'rechazada';
      console.log(
        `[offer-lifecycle] Offer ${tid} ${stateLabel} by winner ${declinedWinnerId}; cancelling delivery and returning items to pool`
      );
      await cancelDeliveriesByTradeOfferId(tid);
      void notify('admin', {
        title: '↩️ Premio devuelto al pool',
        description: `**${steamProfileLink(declinedWinnerLabel, declinedWinnerId)}** ${stateLabel} la oferta de premio. Los items fueron devueltos al pool y desasignados de este ganador.`,
        color: Colors.Yellow,
        fields: [{ name: '🎮 Items', value: declinedItems }]
      });
      return;
    }

    if (
      offer.state === S.Expired ||
      offer.state === S.Canceled ||
      offer.state === S.InvalidItems ||
      offer.state === S.CanceledBySecondFactor
    ) {
      const endedWinnerId = tracked[0]?.winner_steam_id ?? offer.partner.getSteamID64();
      const endedWinnerLabel = await resolvePersonaName(ctx, endedWinnerId);
      const endedItems = tracked.map((r) => `• ${r.item_name}`).join('\n') || '—';
      if (offer.state === S.InvalidItems) {
        console.error(
          `[offer-lifecycle] Offer ${tid} InvalidItems; items no longer valid — resetting to pending`
        );
        void notify('admin', {
          title: '❌ Items inválidos en la oferta',
          description: `La oferta a **${steamProfileLink(endedWinnerLabel, endedWinnerId)}** terminó con estado InvalidItems. Reseteada a pendiente — requiere revisión.`,
          color: Colors.Red,
          fields: [{ name: '🎮 Items', value: endedItems }]
        });
      } else {
        console.log(
          `[offer-lifecycle] Offer ${tid} ended (state=${String(offer.state)}); resetting to pending`
        );
        void notify('admin', {
          title: '⚠️ Oferta de premio finalizada',
          description: `La oferta a **${steamProfileLink(endedWinnerLabel, endedWinnerId)}** terminó con estado \`${String(offer.state)}\`. Reseteada a pendiente.`,
          color: Colors.Yellow,
          fields: [{ name: '🎮 Items', value: endedItems }]
        });
      }
      await resetOfferSentToPendingByTradeOfferId(tid);
    }
  } catch (err) {
    console.error(`[offer-lifecycle] Error handling sent offer ${tid}:`, err);
  }
}

async function handleSentOfferChanged(ctx: SteamContext, offer: TradeOffer): Promise<void> {
  await applyOutboundOfferStateFromSteam(ctx, offer);
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

/**
 * Spec §9: after Steam session is ready, align `offer_sent` rows with Steam's view of each offer.
 */
export async function reconcileOfferSentOnStartup(ctx: SteamContext): Promise<void> {
  const rows = await listOfferSentRows();
  const missingId = rows.filter((r) => r.trade_offer_id === null || r.trade_offer_id.length === 0);
  if (missingId.length > 0) {
    console.warn(
      `[reconcile] ${String(missingId.length)} offer_sent row(s) missing trade_offer_id; skipping those`
    );
  }

  const ids = [
    ...new Set(
      rows.map((r) => r.trade_offer_id).filter((x): x is string => x !== null && x.length > 0)
    )
  ];

  console.log(
    `[reconcile] Startup: ${String(rows.length)} offer_sent row(s), ${String(ids.length)} unique trade_offer_id(s)`
  );

  for (const tradeOfferId of ids) {
    try {
      const offer = await getOffer(ctx.tradeOfferManager, tradeOfferId);
      console.log(
        `[reconcile] trade_offer_id=${tradeOfferId} state=${String(offer.state)} isOurOffer=${String(offer.isOurOffer)}`
      );
      await applyOutboundOfferStateFromSteam(ctx, offer);
    } catch (err) {
      console.error(
        `[reconcile] getOffer failed for trade_offer_id=${tradeOfferId}; leaving DB unchanged:`,
        err
      );
    }
  }

  console.log('[reconcile] Startup reconciliation finished.');
}

/**
 * Cancels a Steam trade offer if it is currently in an active/cancellable state.
 * Safe to call for any offer ID; silently skips if not found or already terminal.
 */
export async function cancelTradeOfferIfActive(
  manager: SteamContext['tradeOfferManager'],
  tradeOfferId: string
): Promise<void> {
  let offer: TradeOffer;
  try {
    offer = await getOffer(manager, tradeOfferId);
  } catch (err) {
    console.warn(`[offer-lifecycle] Could not fetch offer ${tradeOfferId} for admin revoke:`, err);
    return;
  }
  const S = TradeOfferManager.ETradeOfferState;
  if (
    offer.state === S.Active ||
    offer.state === S.CreatedNeedsConfirmation ||
    offer.state === S.InEscrow
  ) {
    try {
      await cancelOffer(offer);
      console.log(`[offer-lifecycle] Cancelled offer ${tradeOfferId} (admin revoke)`);
    } catch (err) {
      console.error(`[offer-lifecycle] Failed to cancel offer ${tradeOfferId} (admin revoke):`, err);
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
