import TradeOfferManager from 'steam-tradeoffer-manager';
import type TradeOffer from 'steam-tradeoffer-manager/lib/classes/TradeOffer.js';
import {
  createDonationSession,
  findActiveDonationSession,
  findPendingDonationOffer,
  hasActiveDonationSession,
  markDonationAcceptedFailed,
  markDonationApproved,
  markDonationRejected,
  markDonationSessionsUsed,
  recordDonationOffer
} from '@/db/donations.ts';
import type { DonationItemInput, DonationReviewerInput } from '@/db/donations.ts';
import { TF2_APP_ID, TF2_CONTEXT_ID } from '@/steam/session.ts';
import type { SteamContext } from '@/steam/session.ts';
import { loadTf2InventoryViaOfferManager } from '@/steam/tf2-inventory.ts';

type TradeItem = {
  appid?: number | string;
  contextid?: number | string;
  assetid?: number | string;
  id?: number | string;
  classid?: number | string;
  instanceid?: number | string;
  market_name?: string;
  name?: string;
  icon_url?: string;
  getImageURL?: () => string;
};

type SteamIdLike = {
  getSteamID64: () => string;
};

const DONATION_COMMAND = '!donate';
let donationChatRegistered = false;

function includesDonationCommand(message: string | null): boolean {
  return (message ?? '').toLowerCase().split(/\s+/).includes(DONATION_COMMAND);
}

function offerMessage(offer: TradeOffer): string | null {
  const raw = (offer as { message?: unknown }).message;
  return typeof raw === 'string' && raw.trim().length > 0 ? raw.trim() : null;
}

function tradeItemAssetId(item: TradeItem): string {
  return String(item.assetid ?? item.id ?? '').trim();
}

function tradeItemAppId(item: TradeItem): number {
  const n = Number(item.appid ?? TF2_APP_ID);
  return Number.isFinite(n) ? n : TF2_APP_ID;
}

function tradeItemContextId(item: TradeItem): string {
  return String(item.contextid ?? TF2_CONTEXT_ID).trim();
}

function tradeItemName(item: TradeItem): string {
  const name = item.market_name ?? item.name;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : 'Unknown item';
}

function tradeItemIconUrl(item: TradeItem): string | null {
  if (typeof item.getImageURL === 'function') {
    try {
      return item.getImageURL();
    } catch {
      return null;
    }
  }
  return typeof item.icon_url === 'string' && item.icon_url.length > 0 ? item.icon_url : null;
}

function mapDonationItems(items: unknown[]): DonationItemInput[] {
  const mapped: DonationItemInput[] = [];
  for (const raw of items) {
    const item = raw as TradeItem;
    const assetId = tradeItemAssetId(item);
    if (!assetId) {
      continue;
    }
    mapped.push({
      appId: tradeItemAppId(item),
      contextId: tradeItemContextId(item),
      assetId,
      classId: item.classid === undefined ? null : String(item.classid),
      instanceId: item.instanceid === undefined ? null : String(item.instanceid),
      name: tradeItemName(item),
      iconUrl: tradeItemIconUrl(item)
    });
  }
  return mapped;
}

function allItemsAreTf2(items: DonationItemInput[]): boolean {
  return items.every(
    (item) => item.appId === TF2_APP_ID && item.contextId === String(TF2_CONTEXT_ID)
  );
}

function itemIdentityKey(item: DonationItemInput): string {
  return `${item.classId ?? ''}:${item.instanceId ?? ''}:${item.name}`;
}

async function reconcileAcceptedItems(
  ctx: SteamContext,
  donatedItems: DonationItemInput[]
): Promise<DonationItemInput[]> {
  try {
    const inventory = mapDonationItems(await loadTf2InventoryViaOfferManager(ctx.tradeOfferManager));
    const used = new Set<string>();
    return donatedItems.map((donated) => {
      const exact = inventory.find((item) => item.assetId === donated.assetId && !used.has(item.assetId));
      if (exact) {
        used.add(exact.assetId);
        return { ...exact, name: donated.name };
      }

      const donatedKey = itemIdentityKey(donated);
      const matched = inventory.find(
        (item) => itemIdentityKey(item) === donatedKey && !used.has(item.assetId)
      );
      if (matched) {
        used.add(matched.assetId);
        return { ...matched, name: donated.name };
      }

      return donated;
    });
  } catch (err) {
    console.error('[donations] Failed to reconcile accepted donation items:', err);
    return donatedItems;
  }
}

function getOffer(manager: SteamContext['tradeOfferManager'], tradeOfferId: string): Promise<TradeOffer> {
  return new Promise((resolve, reject) => {
    manager.getOffer(tradeOfferId, (err, offer) => {
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

export async function createGameDonationSession(
  donorSteamId: string,
  donorName: string | null
): Promise<void> {
  await createDonationSession(donorSteamId, donorName, 'game_command');
}

export async function createSteamDonationSession(
  donorSteamId: string,
  donorName: string | null
): Promise<void> {
  await createDonationSession(donorSteamId, donorName, 'steam_dm');
}

export async function shouldAllowDonationFriendRequest(donorSteamId: string): Promise<boolean> {
  return hasActiveDonationSession(donorSteamId);
}

export async function tryRecordIncomingDonationOffer(offer: TradeOffer): Promise<boolean> {
  const donorSteamId = offer.partner.getSteamID64();
  const message = offerMessage(offer);
  const activeSession = await findActiveDonationSession(donorSteamId);
  const hasDonationIntent = includesDonationCommand(message) || activeSession !== null;

  if (!hasDonationIntent) {
    return false;
  }

  const offerId = offer.id;
  if (offerId === null || offerId === undefined) {
    throw new Error('Donation offer has no trade offer id');
  }

  if (offer.itemsToGive.length > 0) {
    throw new Error('Donation offer asks for bot items');
  }

  const items = mapDonationItems(offer.itemsToReceive as unknown[]);
  if (items.length === 0) {
    throw new Error('Donation offer has no usable received items');
  }
  if (!allItemsAreTf2(items)) {
    throw new Error('Donation offer includes non-TF2 inventory items');
  }

  await recordDonationOffer({
    tradeOfferId: String(offerId),
    donorSteamId,
    donorName: activeSession?.donor_name ?? null,
    message,
    items
  });
  await markDonationSessionsUsed(donorSteamId);
  return true;
}

export async function approveDonationOffer(
  ctx: SteamContext,
  tradeOfferId: string,
  reviewer: DonationReviewerInput
): Promise<void> {
  const pending = await findPendingDonationOffer(tradeOfferId);
  if (!pending) {
    throw new Error('Donation offer is not pending review');
  }

  let offer: TradeOffer;
  try {
    offer = await getOffer(ctx.tradeOfferManager, tradeOfferId);
  } catch (err) {
    await markDonationAcceptedFailed(tradeOfferId, reviewer, String(err));
    throw err;
  }

  if (offer.state !== TradeOfferManager.ETradeOfferState.Active) {
    const reason = `Steam offer is not active (state=${String(offer.state)})`;
    await markDonationAcceptedFailed(tradeOfferId, reviewer, reason);
    throw new Error(reason);
  }

  if (offer.itemsToGive.length > 0) {
    const reason = 'Donation offer asks for bot items';
    await markDonationAcceptedFailed(tradeOfferId, reviewer, reason);
    throw new Error(reason);
  }

  const items = mapDonationItems(offer.itemsToReceive as unknown[]);
  if (items.length === 0 || !allItemsAreTf2(items)) {
    const reason = 'Donation offer has no acceptable TF2 items';
    await markDonationAcceptedFailed(tradeOfferId, reviewer, reason);
    throw new Error(reason);
  }

  try {
    const status = await acceptOffer(offer);
    console.log(`[donations] Accepted donation offer ${tradeOfferId} (status: ${status})`);
  } catch (err) {
    await markDonationAcceptedFailed(tradeOfferId, reviewer, String(err));
    throw err;
  }

  const currentItems = await reconcileAcceptedItems(ctx, items);
  await markDonationApproved(pending, reviewer, currentItems);
}

export async function rejectDonationOffer(
  ctx: SteamContext,
  tradeOfferId: string,
  reviewer: DonationReviewerInput
): Promise<void> {
  const pending = await findPendingDonationOffer(tradeOfferId);
  if (!pending) {
    throw new Error('Donation offer is not pending review');
  }

  try {
    const offer = await getOffer(ctx.tradeOfferManager, tradeOfferId);
    if (offer.state === TradeOfferManager.ETradeOfferState.Active) {
      await declineOffer(offer);
    }
  } catch (err) {
    console.error(`[donations] Failed to decline donation offer ${tradeOfferId}:`, err);
  }

  await markDonationRejected(tradeOfferId, reviewer);
}

export function registerDonationChat(ctx: SteamContext): void {
  if (donationChatRegistered) {
    return;
  }
  donationChatRegistered = true;

  ctx.user.chat.on('friendMessage', (msg) => {
    if (msg.local_echo) {
      return;
    }

    const raw = (msg.message_no_bbcode ?? msg.message).trim();
    const firstToken = raw.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (firstToken !== DONATION_COMMAND) {
      return;
    }

    const friendSid = msg.steamid_friend as SteamIdLike;
    const donorSteamId = friendSid.getSteamID64();

    void (async () => {
      await createSteamDonationSession(donorSteamId, null);
      await ctx.user.chat.sendFriendMessage(
        donorSteamId,
        'Donation window opened for 15 minutes. Send me a trade offer containing only donated TF2 items, with !donate in the trade message. An admin will review it before I accept.'
      );
    })().catch((err: unknown) => {
      console.error(`[donations] Error handling !donate from ${donorSteamId}:`, err);
    });
  });
}
