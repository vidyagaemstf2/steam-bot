import type TradeOffer from 'steam-tradeoffer-manager/lib/classes/TradeOffer.js';
import TradeOfferManager from 'steam-tradeoffer-manager';
import {
  deletePendingDonationOffer,
  findPendingDonationOffer,
  listPendingDonationOffers,
  markDonationRejectedByPolicy,
  upsertPrizePoolItemDirect
} from '@/db/donations.ts';
import { isBotAdmin } from '@/env.ts';
import { resolveExchangeAssetIds, storePricesForItems, tryRecordIncomingDonationOffer } from '@/services/donations.ts';
import { confirmTradeOfferWithRetries } from '@/steam/confirm.ts';
import { TF2_APP_ID } from '@/steam/session.ts';
import type { SteamContext } from '@/steam/session.ts';
import { Colors, notify, steamProfileLink } from '@/utils/discord.ts';

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

export async function handleIncomingOffer(offer: TradeOffer, ctx: SteamContext): Promise<void> {
  const steamId = offer.partner.getSteamID64();
  const offerId = String(offer.id ?? 'unknown');

  console.log(`[trades] Incoming offer ${offerId} from ${steamId}`);

  const decline = async (reason: string): Promise<void> => {
    console.log(`[trades] Declining offer ${offerId} from ${steamId}: ${reason}`);
    try {
      await declineOffer(offer);
    } catch (err) {
      console.error(`[trades] Failed to decline offer ${offerId}:`, err);
      return;
    }

    if (offerId !== 'unknown') {
      try {
        await markDonationRejectedByPolicy(offerId, reason);
      } catch (err) {
        console.error(`[trades] Failed to mark declined offer ${offerId} in DB:`, err);
      }
    }
  };

  if (!isBotAdmin(steamId)) {
    try {
      const recordedDonation = await tryRecordIncomingDonationOffer(offer, ctx);
      if (recordedDonation) {
        console.log(`[trades] Donation offer ${offerId} from ${steamId} queued for admin review`);
        const donorLink = steamProfileLink(
          recordedDonation.donor_name ?? recordedDonation.donor_steam_id,
          recordedDonation.donor_steam_id
        );
        const itemList = recordedDonation.items.map((i) => `• ${i.name}`).join('\n') || '—';
        void notify('admin', {
          title: '📬 Nueva oferta de donación pendiente',
          description: `**${donorLink}** envió una oferta de donación con ${String(recordedDonation.items.length)} item(s). Requiere aprobación.`,
          color: Colors.Blue,
          fields: [{ name: `🎮 Items (${String(recordedDonation.items.length)})`, value: itemList }]
        });
        return;
      }
      await decline('sender is not in BOT_ADMINS and offer is not marked as a donation');
    } catch (err) {
      await decline(err instanceof Error ? err.message : String(err));
    }
    return;
  }

  console.log(`[trades] Accepting offer ${offerId} from admin ${steamId}`);

  type RawOfferItem = {
    appid: number;
    assetid: string;
    market_hash_name?: string;
    market_name?: string;
    name?: string;
  };

  let acceptStatus: string;
  try {
    acceptStatus = await acceptOffer(offer);
    console.log(`[trades] Offer ${offerId} accepted (status: ${acceptStatus})`);
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

  const rawReceived = (offer as unknown as { itemsToReceive?: RawOfferItem[] }).itemsToReceive ?? [];
  const tf2Received = rawReceived.filter((i) => i.appid === TF2_APP_ID);
  if (tf2Received.length === 0) return;

  const newIdMap = await resolveExchangeAssetIds(offer, offerId);

  const prizeEntries: Array<{ assetId: string; name: string }> = [];
  for (const item of tf2Received) {
    const resolvedId = newIdMap.get(item.assetid) ?? item.assetid;
    const name = item.market_hash_name ?? item.market_name ?? item.name ?? '';
    try {
      await upsertPrizePoolItemDirect(resolvedId, name, steamId);
      prizeEntries.push({ assetId: resolvedId, name });
    } catch (err) {
      console.error(`[trades] Failed to upsert prize pool row for ${resolvedId}:`, err);
    }
  }

  void storePricesForItems(prizeEntries);
}

async function handleReceivedOfferChanged(offer: TradeOffer): Promise<void> {
  if (offer.id === null || offer.id === undefined) return;

  const tid = String(offer.id);
  const S = TradeOfferManager.ETradeOfferState;

  const isCancelledState =
    offer.state === S.Canceled ||
    offer.state === S.Expired ||
    offer.state === S.InvalidItems ||
    offer.state === S.CanceledBySecondFactor;

  if (!isCancelledState) return;

  let donation;
  try {
    donation = await findPendingDonationOffer(tid);
  } catch (err) {
    console.error(`[trades] Failed to look up donation offer ${tid}:`, err);
    return;
  }

  if (!donation) return;

  try {
    await deletePendingDonationOffer(tid);
  } catch (err) {
    console.error(`[trades] Failed to delete donation offer ${tid}:`, err);
    return;
  }

  console.log(
    `[trades] Donation offer ${tid} cancelled/expired (state=${String(offer.state)}); removed from DB`
  );

  const donorLink = steamProfileLink(
    donation.donor_name ?? donation.donor_steam_id,
    donation.donor_steam_id
  );
  const itemList = donation.items.map((i) => `• ${i.name}`).join('\n') || '—';
  void notify('admin', {
    title: '❌ Donación cancelada por el donante',
    description: `**${donorLink}** canceló su oferta de donación antes de ser aprobada. Eliminada de la base de datos.`,
    color: Colors.Red,
    fields: [{ name: `🎮 Items (${String(donation.items.length)})`, value: itemList }]
  });
}

export async function reconcilePendingDonationsOnStartup(ctx: SteamContext): Promise<void> {
  const rows = await listPendingDonationOffers();
  if (rows.length === 0) {
    console.log('[reconcile-donations] No pending donation offers to reconcile.');
    return;
  }

  console.log(
    `[reconcile-donations] Reconciling ${String(rows.length)} pending donation offer(s)...`
  );

  const S = TradeOfferManager.ETradeOfferState;

  for (const donation of rows) {
    try {
      const steamOffer = await getOffer(ctx.tradeOfferManager, donation.trade_offer_id);
      if (steamOffer.state === S.Active) continue;

      const deleted = await deletePendingDonationOffer(donation.trade_offer_id);
      if (!deleted) continue;

      console.log(
        `[reconcile-donations] Donation offer ${donation.trade_offer_id} was not Active (state=${String(steamOffer.state)}); removed from DB`
      );

      const donorLink = steamProfileLink(
        donation.donor_name ?? donation.donor_steam_id,
        donation.donor_steam_id
      );
      const itemList = donation.items.map((i) => `• ${i.name}`).join('\n') || '—';
      void notify('admin', {
        title: '❌ Donación cancelada por el donante',
        description: `**${donorLink}** canceló su oferta de donación antes de ser aprobada. Eliminada de la base de datos.`,
        color: Colors.Red,
        fields: [{ name: `🎮 Items (${String(donation.items.length)})`, value: itemList }]
      });
    } catch (err) {
      console.error(
        `[reconcile-donations] getOffer failed for ${donation.trade_offer_id}; leaving DB unchanged:`,
        err
      );
    }
  }

  console.log('[reconcile-donations] Done.');
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
 * Registers `newOffer` + `receivedOfferChanged` and processes any active received offers once (after cookies are ready).
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

  ctx.tradeOfferManager.on('receivedOfferChanged', (offer: TradeOffer) => {
    void handleReceivedOfferChanged(offer);
  });

  pollActiveReceivedOffers(ctx);
}
