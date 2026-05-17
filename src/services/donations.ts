import type TradeOffer from 'steam-tradeoffer-manager/lib/classes/TradeOffer.js';
import TradeOfferManager from 'steam-tradeoffer-manager';
import {
  findPendingDonationOffer,
  markDonationAcceptedFailed,
  markDonationApproved,
  markDonationRejected,
  recordDonationOffer,
  type DonationItemInput,
  type DonationReviewerInput,
  type PendingDonationOffer
} from '@/db/donations.ts';
import { confirmTradeOfferWithRetries } from '@/steam/confirm.ts';
import { TF2_APP_ID } from '@/steam/session.ts';
import type { SteamContext } from '@/steam/session.ts';
import { Colors, notify } from '@/utils/discord.ts';

const DONATION_KEYWORDS = ['!donar', '!donate'];

function hasDonationKeyword(message: string | null | undefined): boolean {
  if (!message) {
    return false;
  }
  const lower = message.toLowerCase();
  return DONATION_KEYWORDS.some((kw) => {
    const idx = lower.indexOf(kw);
    if (idx === -1) {
      return false;
    }
    const charBefore = lower[idx - 1];
    const charAfter = lower[idx + kw.length];
    const before = idx === 0 || charBefore === undefined || /\s/.test(charBefore);
    const after = charAfter === undefined || /\s/.test(charAfter);
    return before && after;
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

type OfferItem = {
  appid: number;
  contextid: string;
  assetid: string;
  classid?: string | null;
  instanceid?: string | null;
  market_hash_name?: string;
  market_name?: string;
  name?: string;
  getImageURL?: () => string;
};

export async function tryRecordIncomingDonationOffer(
  offer: TradeOffer,
  _ctx: SteamContext
): Promise<PendingDonationOffer | null> {
  const offerData = offer as unknown as { message?: string | null; itemsToReceive?: OfferItem[] };
  const message = offerData.message ?? null;

  if (!hasDonationKeyword(message)) {
    return null;
  }

  const items: OfferItem[] = offerData.itemsToReceive ?? [];
  if (items.length === 0) {
    throw new Error('Donation offer contains no items to receive');
  }

  const nonTf2 = items.filter((item) => item.appid !== TF2_APP_ID);
  if (nonTf2.length > 0) {
    throw new Error(
      `Donation offer contains non-TF2 items (appid ${String(nonTf2[0]?.appid ?? 'unknown')})`
    );
  }

  const steamId = offer.partner.getSteamID64();
  const offerId = String(offer.id ?? 'unknown');

  const donationItems: DonationItemInput[] = items.map((item) => ({
    appId: item.appid,
    contextId: item.contextid,
    assetId: item.assetid,
    classId: item.classid ?? null,
    instanceId: item.instanceid ?? null,
    name: item.market_hash_name ?? item.market_name ?? item.name ?? '',
    iconUrl: item.getImageURL ? item.getImageURL() : null
  }));

  return recordDonationOffer({
    tradeOfferId: offerId,
    donorSteamId: steamId,
    donorName: null,
    message,
    items: donationItems
  });
}

export async function approveDonationOffer(
  ctx: SteamContext,
  tradeOfferId: string,
  reviewer: DonationReviewerInput
): Promise<void> {
  const pendingOffer = await findPendingDonationOffer(tradeOfferId);
  if (!pendingOffer) {
    throw new Error(`No pending donation offer found for trade offer ID ${tradeOfferId}`);
  }

  let steamOffer: TradeOffer;
  try {
    steamOffer = await getOffer(ctx.tradeOfferManager, tradeOfferId);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await markDonationAcceptedFailed(
      tradeOfferId,
      reviewer,
      `Failed to fetch trade offer: ${reason}`
    );
    throw new Error(`Failed to fetch trade offer ${tradeOfferId}: ${reason}`);
  }

  const S = TradeOfferManager.ETradeOfferState;
  if (steamOffer.state !== S.Active) {
    const reason = `Trade offer is not active (state: ${String(steamOffer.state)})`;
    await markDonationAcceptedFailed(tradeOfferId, reviewer, reason);
    throw new Error(reason);
  }

  try {
    await acceptOffer(steamOffer);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await markDonationAcceptedFailed(tradeOfferId, reviewer, `Accept failed: ${reason}`);
    throw new Error(`Failed to accept trade offer ${tradeOfferId}: ${reason}`);
  }

  const offerId = String(steamOffer.id ?? tradeOfferId);
  try {
    await confirmTradeOfferWithRetries(ctx.community, ctx.identitySecret, offerId, {
      logPrefix: '[donations]'
    });
  } catch (err) {
    console.error(
      `[donations] Mobile confirmation failed for offer ${offerId}:`,
      err instanceof Error ? err.message : String(err)
    );
  }

  const prizeItems: DonationItemInput[] = pendingOffer.items.map((item) => ({
    appId: item.app_id,
    contextId: item.context_id,
    assetId: item.asset_id,
    classId: item.class_id ?? null,
    instanceId: item.instance_id ?? null,
    name: item.name,
    iconUrl: item.icon_url ?? null
  }));

  await markDonationApproved(pendingOffer, reviewer, prizeItems);

  void notify('donations', {
    title: 'Donación aprobada',
    description: `Oferta de **${pendingOffer.donor_name ?? pendingOffer.donor_steam_id}** aprobada por ${reviewer.reviewerName ?? reviewer.reviewerSteamId ?? 'admin'}.`,
    color: Colors.Green,
    fields: pendingOffer.items.map((item) => ({
      name: item.name,
      value: item.asset_id,
      inline: true
    }))
  });
}

export async function rejectDonationOffer(
  ctx: SteamContext,
  tradeOfferId: string,
  reviewer: DonationReviewerInput
): Promise<void> {
  const pendingOffer = await findPendingDonationOffer(tradeOfferId);
  if (!pendingOffer) {
    throw new Error(`No pending donation offer found for trade offer ID ${tradeOfferId}`);
  }

  try {
    const steamOffer = await getOffer(ctx.tradeOfferManager, tradeOfferId);
    const S = TradeOfferManager.ETradeOfferState;
    if (steamOffer.state === S.Active) {
      await declineOffer(steamOffer);
    }
  } catch (err) {
    console.error(
      `[donations] Failed to decline Steam offer ${tradeOfferId} during rejection:`,
      err instanceof Error ? err.message : String(err)
    );
  }

  await markDonationRejected(tradeOfferId, reviewer);

  void notify('donations', {
    title: 'Donación rechazada',
    description: `Oferta de **${pendingOffer.donor_name ?? pendingOffer.donor_steam_id}** rechazada por ${reviewer.reviewerName ?? reviewer.reviewerSteamId ?? 'admin'}.`,
    color: Colors.Red
  });
}
