import SteamUser from 'steam-user';
import type TradeOffer from 'steam-tradeoffer-manager/lib/classes/TradeOffer.js';
import { listPendingRowsForWinner, markRowsOfferSent } from '@/db/pending-deliveries.ts';
import { confirmTradeOfferWithRetries } from '@/steam/confirm.ts';
import type { SteamContext } from '@/steam/session.ts';
import { loadTf2InventoryViaOfferManager } from '@/steam/tf2-inventory.ts';

type OfferItem = Parameters<TradeOffer['addMyItem']>[0];

async function loadBotTf2Inventory(manager: SteamContext['tradeOfferManager']): Promise<OfferItem[]> {
  const merged = await loadTf2InventoryViaOfferManager(manager);
  return merged as OfferItem[];
}

function sendOffer(offer: TradeOffer): Promise<'pending' | 'sent'> {
  return new Promise((resolve, reject) => {
    offer.send((err, status) => {
      if (err) {
        reject(err);
      } else if (status === undefined) {
        reject(new Error('offer.send: missing status'));
      } else {
        resolve(status);
      }
    });
  });
}

const deliveringPartners = new Set<string>();

async function attemptDeliverPrizes(ctx: SteamContext, partnerId64: string): Promise<void> {
  const rows = await listPendingRowsForWinner(partnerId64);
  if (rows.length === 0) {
    return;
  }

  console.log(`[delivery] Pending deliveries for ${partnerId64}: ${String(rows.length)} row(s)`);

  let inventory: OfferItem[];
  try {
    inventory = await loadBotTf2Inventory(ctx.tradeOfferManager);
  } catch (err) {
    console.error(`[delivery] Failed to load bot inventory for ${partnerId64}:`, err);
    return;
  }

  const byAsset = new Map<string, OfferItem>();
  for (const item of inventory) {
    const id = String(item.assetid ?? item.id).trim();
    if (id.length > 0) {
      byAsset.set(id, item);
    }
  }

  const uniqueAssetIds = [...new Set(rows.map((r) => r.asset_id.trim()))];
  const missing: string[] = [];
  const itemsToAttach: OfferItem[] = [];

  for (const aid of uniqueAssetIds) {
    const found = byAsset.get(aid);
    if (!found) {
      missing.push(aid);
    } else {
      itemsToAttach.push(found);
    }
  }

  if (missing.length > 0) {
    console.error(
      `[delivery] Cannot send prize offer to ${partnerId64}: assets not in bot tradable inventory: ${missing.join(', ')}`
    );
    return;
  }

  const offer = ctx.tradeOfferManager.createOffer(partnerId64);
  for (const item of itemsToAttach) {
    offer.addMyItem(item);
  }
  if (offer.itemsToGive.length === 0) {
    console.error(`[delivery] No items on offer for ${partnerId64}; aborting`);
    return;
  }
  offer.setMessage('Prize from giveaway');

  let sendStatus: 'pending' | 'sent';
  try {
    sendStatus = await sendOffer(offer);
    console.log(
      `[delivery] Offer send to ${partnerId64} status=${sendStatus} tradeOfferId=${String(offer.id ?? '')}`
    );
  } catch (err) {
    console.error(`[delivery] Failed to send offer to ${partnerId64}:`, err);
    return;
  }

  const oid = offer.id;
  if (oid === null || oid === undefined) {
    console.error('[delivery] Sent offer has no id; not updating DB');
    return;
  }
  const idStr = String(oid);

  if (offer.itemsToGive.length > 0) {
    try {
      await confirmTradeOfferWithRetries(ctx.community, ctx.identitySecret, idStr, {
        logPrefix: '[delivery]'
      });
      console.log(`[delivery] Offer ${idStr} confirmed via STEAM_IDENTITY_SECRET`);
    } catch (err) {
      console.error(`[delivery] Failed to confirm offer ${idStr}:`, err);
      return;
    }
  }

  try {
    await markRowsOfferSent(
      rows.map((r) => r.id),
      idStr
    );
    console.log(
      `[delivery] Marked ${String(rows.length)} row(s) as offer_sent trade_offer_id=${idStr}`
    );
  } catch (err) {
    console.error(`[delivery] Failed to update DB after offer ${idStr}:`, err);
  }
}

/**
 * Queues the same outbound prize flow as on friend add (mutex per winner).
 * Use when a user asks to retry (e.g. chat `!claim`) or from tests.
 */
export function triggerPrizeDelivery(ctx: SteamContext, partnerId64: string): void {
  void (async () => {
    if (deliveringPartners.has(partnerId64)) {
      console.log(`[delivery] Skip concurrent delivery for ${partnerId64}`);
      return;
    }
    deliveringPartners.add(partnerId64);
    try {
      await attemptDeliverPrizes(ctx, partnerId64);
    } catch (err) {
      console.error(`[delivery] Unexpected error for ${partnerId64}:`, err);
    } finally {
      deliveringPartners.delete(partnerId64);
    }
  })();
}

let outboundDeliveryRegistered = false;

/**
 * On friendship (`Friend`), sends one trade with all pending items for that SteamID64.
 * Safe to call once per process.
 */
export function registerOutboundDelivery(ctx: SteamContext): void {
  if (outboundDeliveryRegistered) {
    return;
  }
  outboundDeliveryRegistered = true;

  ctx.user.on('friendRelationship', (steamId, relationship) => {
    if (relationship !== SteamUser.EFriendRelationship.Friend) {
      return;
    }

    const partnerId64 = steamId.getSteamID64();
    triggerPrizeDelivery(ctx, partnerId64);
  });
}
