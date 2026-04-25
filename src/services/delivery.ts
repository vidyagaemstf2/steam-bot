import SteamUser from 'steam-user';
import type TradeOffer from 'steam-tradeoffer-manager/lib/classes/TradeOffer.js';
import {
  listPendingRowsForWinner,
  markRowsDeliveryAttemptFailed,
  markRowsOfferSent
} from '@/db/pending-deliveries.ts';
import { confirmTradeOfferWithRetries } from '@/steam/confirm.ts';
import type { SteamContext } from '@/steam/session.ts';
import { loadTf2InventoryViaCommunity } from '@/steam/tf2-inventory.ts';

type OfferItem = Parameters<TradeOffer['addMyItem']>[0];
type DeliveryFailureCode =
  | 'bot_inventory_unavailable'
  | 'bot_item_missing'
  | 'winner_trade_restricted'
  | 'steam_temporary'
  | 'confirmation_failed'
  | 'offer_missing_id'
  | 'database_update_failed'
  | 'already_running'
  | 'no_pending'
  | 'unknown';

type DeliveryFailure = {
  code: DeliveryFailureCode;
  message: string;
};

export type DeliveryAttemptResult =
  | { ok: true; code: 'sent'; tradeOfferId: string; message: string }
  | { ok: true; code: 'no_pending'; message: string }
  | { ok: false; code: DeliveryFailureCode; message: string };

async function loadBotTf2Inventory(ctx: SteamContext): Promise<OfferItem[]> {
  const sid = ctx.user.steamID;
  if (!sid) {
    throw new Error('Steam user has no steamID yet');
  }

  const merged = await loadTf2InventoryViaCommunity(ctx.community, sid.getSteamID64());
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

function normalizeDbAssetId(raw: string): string {
  return raw.trim().replace(/^"+|"+$/g, '');
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === 'string') {
    return err;
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

function classifySendFailure(err: unknown): DeliveryFailure {
  const message = errorText(err);
  const lower = message.toLowerCase();

  if (
    lower.includes('escrow') ||
    lower.includes('hold') ||
    lower.includes('mobile authenticator') ||
    lower.includes('steam guard') ||
    lower.includes('trade ban') ||
    lower.includes('trade banned') ||
    lower.includes('cannot trade') ||
    lower.includes('can not trade') ||
    lower.includes('not allowed') ||
    lower.includes('not eligible') ||
    lower.includes('ineligible') ||
    lower.includes('limited') ||
    lower.includes('private') ||
    lower.includes('not friends') ||
    lower.includes('friend')
  ) {
    return {
      code: 'winner_trade_restricted',
      message:
        'Steam no me dejo crear la oferta. Tu cuenta parece no estar habilitada para recibir intercambios ahora mismo. Revisa Steam Guard Mobile Authenticator, restricciones de intercambio, inventario/perfil privado, trade ban o si realmente somos amigos. Cuando lo soluciones, usa !reclamar otra vez.'
    };
  }

  if (
    lower.includes('timeout') ||
    lower.includes('temporar') ||
    lower.includes('busy') ||
    lower.includes('rate') ||
    lower.includes('unavailable') ||
    lower.includes('eresult: 2') ||
    lower.includes('eresult: 16')
  ) {
    return {
      code: 'steam_temporary',
      message:
        'Steam rechazo la oferta con un error temporal. Proba usar !reclamar otra vez en unos minutos.'
    };
  }

  return {
    code: 'unknown',
    message:
      'Steam rechazo la oferta y no pude identificar el motivo exacto. Revisa que tu cuenta pueda intercambiar y usa !reclamar otra vez. Si sigue pasando, avisale a un admin.'
  };
}

async function failRows(
  rowIds: number[],
  failure: DeliveryFailure
): Promise<DeliveryAttemptResult> {
  await markRowsDeliveryAttemptFailed(rowIds, failure);
  return { ok: false, code: failure.code, message: failure.message };
}

async function attemptDeliverPrizes(
  ctx: SteamContext,
  partnerId64: string
): Promise<DeliveryAttemptResult> {
  const rows = await listPendingRowsForWinner(partnerId64);
  if (rows.length === 0) {
    return {
      ok: true,
      code: 'no_pending',
      message: 'No tenes ningun premio pendiente para reclamar.'
    };
  }
  const rowIds = rows.map((r) => r.id);

  console.log(`[delivery] Pending deliveries for ${partnerId64}: ${String(rows.length)} row(s)`);

  let inventory: OfferItem[];
  try {
    inventory = await loadBotTf2Inventory(ctx);
  } catch (err) {
    console.error(`[delivery] Failed to load bot inventory for ${partnerId64}:`, err);
    return await failRows(rowIds, {
      code: 'bot_inventory_unavailable',
      message:
        'No pude revisar el inventario del bot en este momento. Proba usar !reclamar otra vez en unos minutos.'
    });
  }

  const byAsset = new Map<string, OfferItem>();
  for (const item of inventory) {
    const id = String(item.assetid ?? item.id).trim();
    if (id.length > 0) {
      byAsset.set(id, item);
    }
  }

  const uniqueAssetIds = [...new Set(rows.map((r) => normalizeDbAssetId(r.asset_id)))];
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
    return await failRows(rowIds, {
      code: 'bot_item_missing',
      message:
        'No encontre el item del premio en el inventario tradable del bot. Esto necesita que un admin lo revise.'
    });
  }

  const offer = ctx.tradeOfferManager.createOffer(partnerId64);
  for (const item of itemsToAttach) {
    offer.addMyItem(item);
  }
  if (offer.itemsToGive.length === 0) {
    console.error(`[delivery] No items on offer for ${partnerId64}; aborting`);
    return await failRows(rowIds, {
      code: 'bot_item_missing',
      message:
        'No pude armar la oferta porque no encontre items validos para enviar. Esto necesita que un admin lo revise.'
    });
  }
  offer.setMessage('Premio de sorteo');

  let sendStatus: 'pending' | 'sent';
  try {
    sendStatus = await sendOffer(offer);
    console.log(
      `[delivery] Offer send to ${partnerId64} status=${sendStatus} tradeOfferId=${String(offer.id ?? '')}`
    );
  } catch (err) {
    console.error(`[delivery] Failed to send offer to ${partnerId64}:`, err);
    return await failRows(rowIds, classifySendFailure(err));
  }

  const oid = offer.id;
  if (oid === null || oid === undefined) {
    console.error('[delivery] Sent offer has no id; not updating DB');
    return await failRows(rowIds, {
      code: 'offer_missing_id',
      message:
        'Steam creo una oferta pero no devolvio el ID. Usa !reclamar otra vez; si se repite, avisale a un admin.'
    });
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
      return await failRows(rowIds, {
        code: 'confirmation_failed',
        message:
          'Pude crear la oferta, pero fallo la confirmacion movil del bot. Esto necesita que un admin revise el bot.'
      });
    }
  }

  try {
    await markRowsOfferSent(rowIds, idStr);
    console.log(
      `[delivery] Marked ${String(rows.length)} row(s) as offer_sent trade_offer_id=${idStr}`
    );
  } catch (err) {
    console.error(`[delivery] Failed to update DB after offer ${idStr}:`, err);
    return await failRows(rowIds, {
      code: 'database_update_failed',
      message:
        'La oferta se creo, pero falle guardando el estado en la base de datos. Avisale a un admin antes de reintentar.'
    });
  }

  return {
    ok: true,
    code: 'sent',
    tradeOfferId: idStr,
    message: 'Listo, te mande la oferta de intercambio. Revisala en Steam.'
  };
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

export async function requestPrizeDelivery(
  ctx: SteamContext,
  partnerId64: string
): Promise<DeliveryAttemptResult> {
  if (deliveringPartners.has(partnerId64)) {
    return {
      ok: false,
      code: 'already_running',
      message: 'Ya estoy intentando mandar tu premio. Espera un momento y revisa Steam.'
    };
  }

  deliveringPartners.add(partnerId64);
  try {
    return await attemptDeliverPrizes(ctx, partnerId64);
  } catch (err) {
    console.error(`[delivery] Unexpected error for ${partnerId64}:`, err);
    return {
      ok: false,
      code: 'unknown',
      message:
        'Paso un error inesperado intentando mandar tu premio. Proba de nuevo en unos minutos o avisale a un admin.'
    };
  } finally {
    deliveringPartners.delete(partnerId64);
  }
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
