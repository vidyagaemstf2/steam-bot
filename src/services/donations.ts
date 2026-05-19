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
import { Colors, notify, steamProfileLink } from '@/utils/discord.ts';

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

type ExchangeReceiptItem = {
  assetid?: string;
  id?: string;
  new_assetid?: string;
};

type TradeOfferWithExchangeDetails = {
  getExchangeDetails: (
    getDetailsIfFailed: boolean,
    callback: (
      err: Error | null,
      status: unknown,
      tradeInitTime: unknown,
      receivedItems: ExchangeReceiptItem[]
    ) => void
  ) => void;
};

const EXCHANGE_DETAIL_ATTEMPTS = 4;
const EXCHANGE_DETAIL_DELAY_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getExchangeDetailsOnce(
  offer: TradeOffer
): Promise<{ map: Map<string, string>; err: string | null }> {
  return new Promise((resolve) => {
    (offer as unknown as TradeOfferWithExchangeDetails).getExchangeDetails(
      false,
      (err, _status, _tradeInitTime, receivedItems) => {
        if (err) {
          resolve({ map: new Map(), err: err.message });
          return;
        }
        const map = new Map<string, string>();
        for (const item of receivedItems ?? []) {
          const oldId = item.assetid ?? item.id;
          if (oldId && item.new_assetid) {
            map.set(oldId, item.new_assetid);
          }
        }
        resolve({ map, err: null });
      }
    );
  });
}

async function resolveExchangeAssetIds(
  offer: TradeOffer,
  offerId: string
): Promise<Map<string, string>> {
  for (let attempt = 1; attempt <= EXCHANGE_DETAIL_ATTEMPTS; attempt++) {
    const { map, err } = await getExchangeDetailsOnce(offer);

    if (err !== null) {
      console.warn(
        `[donations] getExchangeDetails attempt ${String(attempt)}/${String(EXCHANGE_DETAIL_ATTEMPTS)} failed for offer ${offerId}: ${err}`
      );
    } else if (map.size > 0) {
      console.log(
        `[donations] Exchange details resolved on attempt ${String(attempt)}/${String(EXCHANGE_DETAIL_ATTEMPTS)}: ${String(map.size)} mapping(s) for offer ${offerId}`
      );
      return map;
    } else {
      console.log(
        `[donations] Exchange details empty on attempt ${String(attempt)}/${String(EXCHANGE_DETAIL_ATTEMPTS)} for offer ${offerId}; trade may not be fully processed yet`
      );
    }

    if (attempt < EXCHANGE_DETAIL_ATTEMPTS) {
      await sleep(EXCHANGE_DETAIL_DELAY_MS);
    }
  }

  console.warn(
    `[donations] Could not resolve exchange asset IDs for offer ${offerId} after ${String(EXCHANGE_DETAIL_ATTEMPTS)} attempts; donor attribution asset IDs may be stale`
  );
  return new Map();
}

function readCachedPersonaName(ctx: SteamContext, steamId64: string): string | null {
  const persona = (ctx.user.users as Record<string, unknown>)[steamId64] as
    | Record<string, unknown>
    | undefined;
  if (!persona) return null;
  for (const key of ['player_name', 'persona_name', 'personaName', 'name']) {
    const v = persona[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

async function resolveDonorName(ctx: SteamContext, steamId64: string): Promise<string | null> {
  const cached = readCachedPersonaName(ctx, steamId64);
  if (cached) return cached;

  await new Promise<void>((resolve) => {
    ctx.user.getPersonas([steamId64], () => resolve());
  });

  return readCachedPersonaName(ctx, steamId64);
}

export async function tryRecordIncomingDonationOffer(
  offer: TradeOffer,
  ctx: SteamContext
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

  let donorName: string | null = null;
  try {
    donorName = await resolveDonorName(ctx, steamId);
  } catch (err) {
    console.warn(
      `[donations] Could not resolve persona name for ${steamId}:`,
      err instanceof Error ? err.message : String(err)
    );
  }

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
    donorName,
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

  const newAssetIdMap = await resolveExchangeAssetIds(steamOffer, offerId);

  const prizeItems: DonationItemInput[] = pendingOffer.items.map((item) => ({
    appId: item.app_id,
    contextId: item.context_id,
    assetId: newAssetIdMap.get(item.asset_id) ?? item.asset_id,
    classId: item.class_id ?? null,
    instanceId: item.instance_id ?? null,
    name: item.name,
    iconUrl: item.icon_url ?? null
  }));

  await markDonationApproved(pendingOffer, reviewer, prizeItems);

  const donorLinkApprove = steamProfileLink(
    pendingOffer.donor_name ?? pendingOffer.donor_steam_id,
    pendingOffer.donor_steam_id
  );
  const reviewerLinkApprove = reviewer.reviewerSteamId
    ? steamProfileLink(reviewer.reviewerName ?? reviewer.reviewerSteamId, reviewer.reviewerSteamId)
    : (reviewer.reviewerName ?? 'admin');
  const itemCount = pendingOffer.items.length;
  const itemList = pendingOffer.items.map((item) => `• ${item.name}`).join('\n') || '—';

  void notify('donations', {
    title: '🎁 ¡Nueva donación recibida!',
    description: `¡Gracias **${donorLinkApprove}** por donar ${String(itemCount)} item(s) al pool de premios! Tu generosidad hace posibles los sorteos. 🙌`,
    color: Colors.Green,
    fields: [{ name: `🎮 Items donados (${String(itemCount)})`, value: itemList }]
  });
  void notify('admin', {
    title: 'Donación aprobada',
    description: `Oferta de **${donorLinkApprove}** aprobada por ${reviewerLinkApprove}.`,
    color: Colors.Green,
    fields: [{ name: `🎮 Items donados (${String(itemCount)})`, value: itemList }]
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

  const donorLinkReject = steamProfileLink(
    pendingOffer.donor_name ?? pendingOffer.donor_steam_id,
    pendingOffer.donor_steam_id
  );
  const reviewerLinkReject = reviewer.reviewerSteamId
    ? steamProfileLink(reviewer.reviewerName ?? reviewer.reviewerSteamId, reviewer.reviewerSteamId)
    : (reviewer.reviewerName ?? 'admin');
  void notify('admin', {
    title: 'Donación rechazada',
    description: `Oferta de **${donorLinkReject}** rechazada por ${reviewerLinkReject}.`,
    color: Colors.Red
  });
}
