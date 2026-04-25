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

const DONATION_COMMANDS = new Set(['!donate', '!donar']);
let donationChatRegistered = false;

export type DonationSessionView = {
  created: boolean;
  expiresAt: Date;
  expiresInSeconds: number;
};

function secondsUntil(date: Date): number {
  return Math.max(0, Math.ceil((date.getTime() - Date.now()) / 1000));
}

function includesDonationCommand(message: string | null): boolean {
  return (message ?? '')
    .toLowerCase()
    .split(/\s+/)
    .some((token) => DONATION_COMMANDS.has(token));
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

function personaDisplayName(persona: unknown): string | null {
  if (persona === null || typeof persona !== 'object') {
    return null;
  }
  const obj = persona as Record<string, unknown>;
  const candidates = [obj.persona_name, obj.player_name, obj.personaName, obj.name];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }
  return null;
}

async function resolveSteamDisplayName(
  ctx: SteamContext,
  steamId64: string,
  fallback: string | null
): Promise<string | null> {
  const cached = personaDisplayName(ctx.user.users[steamId64]);
  if (cached) {
    return cached;
  }

  try {
    const { personas } = await ctx.user.getPersonas([steamId64]);
    const resolved = personaDisplayName(personas[steamId64]);
    if (resolved) {
      return resolved;
    }
  } catch (err) {
    console.error(`[donations] Failed to resolve Steam persona for ${steamId64}:`, err);
  }

  return fallback;
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
): Promise<DonationSessionView> {
  const result = await createDonationSession(donorSteamId, donorName, 'game_command');
  return {
    created: result.created,
    expiresAt: result.session.expires_at,
    expiresInSeconds: secondsUntil(result.session.expires_at)
  };
}

export async function createSteamDonationSession(
  donorSteamId: string,
  donorName: string | null
): Promise<DonationSessionView> {
  const result = await createDonationSession(donorSteamId, donorName, 'steam_dm');
  return {
    created: result.created,
    expiresAt: result.session.expires_at,
    expiresInSeconds: secondsUntil(result.session.expires_at)
  };
}

export async function shouldAllowDonationFriendRequest(donorSteamId: string): Promise<boolean> {
  return hasActiveDonationSession(donorSteamId);
}

export async function tryRecordIncomingDonationOffer(
  offer: TradeOffer,
  ctx: SteamContext
): Promise<boolean> {
  const donorSteamId = offer.partner.getSteamID64();
  const message = offerMessage(offer);
  const activeSession = await findActiveDonationSession(donorSteamId);
  const hasDonationIntent = includesDonationCommand(message) || activeSession !== null;

  if (!hasDonationIntent) {
    return false;
  }

  const offerId = offer.id;
  if (offerId === null || offerId === undefined) {
    throw new Error('La oferta de donacion no tiene ID de oferta de intercambio');
  }

  if (offer.itemsToGive.length > 0) {
    throw new Error('La oferta de donacion pide items del bot');
  }

  const items = mapDonationItems(offer.itemsToReceive as unknown[]);
  if (items.length === 0) {
    throw new Error('La oferta de donacion no tiene items recibidos utilizables');
  }
  if (!allItemsAreTf2(items)) {
    throw new Error('La oferta de donacion incluye items que no son de TF2');
  }

  await recordDonationOffer({
    tradeOfferId: String(offerId),
    donorSteamId,
    donorName: await resolveSteamDisplayName(ctx, donorSteamId, activeSession?.donor_name ?? null),
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
    throw new Error('La oferta de donacion no esta pendiente de revision');
  }

  let offer: TradeOffer;
  try {
    offer = await getOffer(ctx.tradeOfferManager, tradeOfferId);
  } catch (err) {
    await markDonationAcceptedFailed(tradeOfferId, reviewer, String(err));
    throw err;
  }

  if (offer.state !== TradeOfferManager.ETradeOfferState.Active) {
    const reason = `La oferta de Steam no esta activa (estado=${String(offer.state)})`;
    await markDonationAcceptedFailed(tradeOfferId, reviewer, reason);
    throw new Error(reason);
  }

  if (offer.itemsToGive.length > 0) {
    const reason = 'La oferta de donacion pide items del bot';
    await markDonationAcceptedFailed(tradeOfferId, reviewer, reason);
    throw new Error(reason);
  }

  const items = mapDonationItems(offer.itemsToReceive as unknown[]);
  if (items.length === 0 || !allItemsAreTf2(items)) {
    const reason = 'La oferta de donacion no tiene items de TF2 aceptables';
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
    throw new Error('La oferta de donacion no esta pendiente de revision');
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
    if (!DONATION_COMMANDS.has(firstToken)) {
      return;
    }

    const friendSid = msg.steamid_friend as SteamIdLike;
    const donorSteamId = friendSid.getSteamID64();

    void (async () => {
      const donorName = await resolveSteamDisplayName(ctx, donorSteamId, null);
      const session = await createSteamDonationSession(donorSteamId, donorName);
      const prefix = session.created
        ? 'Ventana de donacion abierta por 15 minutos.'
        : `Ya tenes una ventana de donacion abierta por unos ${String(session.expiresInSeconds)} segundos mas.`;
      await ctx.user.chat.sendFriendMessage(
        donorSteamId,
        `${prefix} Mandame una oferta con solo items de TF2 para donar, e inclui !donar o !donate en el mensaje de la oferta. Un admin la va a revisar antes de que yo la acepte.`
      );
    })().catch((err: unknown) => {
      console.error(`[donations] Error handling !donate from ${donorSteamId}:`, err);
    });
  });
}
