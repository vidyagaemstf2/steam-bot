import SteamUser from 'steam-user';
import type TradeOffer from 'steam-tradeoffer-manager/lib/classes/TradeOffer.js';
import {
  listPendingRowsForWinner,
  markRowsDeliveryAttemptFailed,
  markRowsOfferSent
} from '@/db/pending-deliveries.ts';
import { cancelTradeOfferIfActive } from '@/services/offer-lifecycle.ts';
import { confirmTradeOfferWithRetries, isSteamRateLimitError } from '@/steam/confirm.ts';
import type { SteamContext } from '@/steam/session.ts';
import { loadTf2InventoryViaCommunity } from '@/steam/tf2-inventory.ts';
import { Colors, notify, steamProfileLink } from '@/utils/discord.ts';

const CONFIRMATION_RETRY_COOLDOWN_MS = 60_000;

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

let inventoryInFlight: Promise<OfferItem[]> | null = null;

async function loadBotTf2Inventory(ctx: SteamContext): Promise<OfferItem[]> {
  const sid = ctx.user.steamID;
  if (!sid) {
    throw new Error('Steam user has no steamID yet');
  }

  if (inventoryInFlight) {
    return inventoryInFlight;
  }

  inventoryInFlight = (async () => {
    try {
      const merged = await loadTf2InventoryViaCommunity(ctx.community, sid.getSteamID64());
      return merged as OfferItem[];
    } finally {
      inventoryInFlight = null;
    }
  })();

  return inventoryInFlight;
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

function resolvePersonaName(ctx: SteamContext, steamId64: string): string {
  const persona = (ctx.user.users as Record<string, unknown>)[steamId64] as
    | Record<string, unknown>
    | undefined;
  if (!persona) return steamId64;
  for (const key of ['player_name', 'persona_name', 'personaName', 'name']) {
    const v = persona[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return steamId64;
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

function confirmationCooldownRemainingMs(rows: { last_failure_code: string | null; last_attempt_at: Date | null }[]): number {
  let latestAttempt = 0;
  let hasConfirmFailure = false;
  for (const row of rows) {
    if (row.last_failure_code !== 'confirmation_failed') {
      continue;
    }
    hasConfirmFailure = true;
    const at = row.last_attempt_at?.getTime() ?? 0;
    if (at > latestAttempt) {
      latestAttempt = at;
    }
  }
  if (!hasConfirmFailure || latestAttempt <= 0) {
    return 0;
  }
  const elapsed = Date.now() - latestAttempt;
  return Math.max(0, CONFIRMATION_RETRY_COOLDOWN_MS - elapsed);
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

  const cooldownMs = confirmationCooldownRemainingMs(rows);
  if (cooldownMs > 0) {
    const waitSec = Math.ceil(cooldownMs / 1000);
    console.log(
      `[delivery] Cooldown after confirmation failure for ${partnerId64}; retry in ${String(waitSec)}s`
    );
    return {
      ok: false,
      code: 'confirmation_failed',
      message: `Steam esta limitando las confirmaciones del bot. Proba reclamar de nuevo en unos ${String(waitSec)} segundos.`
    };
  }

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

  const missing: string[] = [];
  const missingRowIds: number[] = [];
  const deliverableRowIds: number[] = [];
  const itemsToAttach: OfferItem[] = [];
  const attachedAssetIds = new Set<string>();

  for (const row of rows) {
    const aid = normalizeDbAssetId(row.asset_id);
    const found = byAsset.get(aid);
    if (!found) {
      missing.push(aid);
      missingRowIds.push(row.id);
    } else {
      deliverableRowIds.push(row.id);
      if (!attachedAssetIds.has(aid)) {
        itemsToAttach.push(found);
        attachedAssetIds.add(aid);
      }
    }
  }

  if (missing.length > 0) {
    console.error(
      `[delivery] Cannot send prize offer to ${partnerId64}: assets not in bot tradable inventory: ${missing.join(', ')}`
    );
    await markRowsDeliveryAttemptFailed(missingRowIds, {
      code: 'bot_item_missing',
      message:
        'No encontre el item del premio en el inventario tradable del bot. Esto necesita que un admin lo revise.'
    });
    const winnerLabel = resolvePersonaName(ctx, partnerId64);
    const missingNames = rows
      .filter((r) => missingRowIds.includes(r.id))
      .map((r) => `• ${r.item_name}`)
      .join('\n') || missing.join('\n');
    void notify('admin', {
      title: '⚠️ Items faltantes en inventario',
      description: `No se pudo entregar a **${steamProfileLink(winnerLabel, partnerId64)}** — item(s) no encontrados en el inventario tradable.`,
      color: Colors.Red,
      fields: [{ name: 'Items faltantes', value: missingNames }],
    });
    if (itemsToAttach.length === 0) {
      return {
        ok: false,
        code: 'bot_item_missing',
        message:
          'No encontre el item del premio en el inventario tradable del bot. Esto necesita que un admin lo revise.'
      };
    }
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
      try {
        await cancelTradeOfferIfActive(ctx.tradeOfferManager, idStr);
        console.log(`[delivery] Cancelled unconfirmed offer ${idStr} after confirmation failure`);
      } catch (cancelErr) {
        console.error(`[delivery] Failed to cancel unconfirmed offer ${idStr}:`, cancelErr);
      }
      const rateLimited = isSteamRateLimitError(err);
      const winnerLabelConf = resolvePersonaName(ctx, partnerId64);
      const confItems = rows
        .filter((r) => deliverableRowIds.includes(r.id))
        .map((r) => `• ${r.item_name}`)
        .join('\n') || '—';
      void notify('admin', {
        title: rateLimited ? '⏳ Confirmación móvil rate-limited' : '❌ Confirmación móvil fallida',
        description: rateLimited
          ? `La oferta a **${steamProfileLink(winnerLabelConf, partnerId64)}** se creó pero Steam rate-limiteó la confirmación (429). La oferta fue cancelada; el ganador puede reintentar tras el cooldown.`
          : `La oferta a **${steamProfileLink(winnerLabelConf, partnerId64)}** fue creada pero la confirmación móvil falló. La oferta fue cancelada.`,
        color: Colors.Red,
        fields: [
          { name: 'Items', value: confItems },
          { name: 'Error', value: err instanceof Error ? err.message : String(err) },
        ],
      });
      return await failRows(deliverableRowIds, {
        code: 'confirmation_failed',
        message: rateLimited
          ? 'Steam esta limitando las confirmaciones del bot ahora mismo. Proba reclamar de nuevo en un minuto.'
          : 'Pude crear la oferta, pero fallo la confirmacion movil del bot. Proba reclamar de nuevo en un minuto; si se repite, avisale a un admin.'
      });
    }
  }

  try {
    await markRowsOfferSent(deliverableRowIds, idStr);
    console.log(
      `[delivery] Marked ${String(deliverableRowIds.length)} row(s) as offer_sent trade_offer_id=${idStr}`
    );
    const winnerLabelSent = resolvePersonaName(ctx, partnerId64);
    const sentItems = rows
      .filter((r) => deliverableRowIds.includes(r.id))
      .map((r) => `• ${r.item_name}`)
      .join('\n') || '—';
    void notify('admin', {
      title: '📦 Oferta de premio enviada',
      description: `Oferta enviada a **${steamProfileLink(winnerLabelSent, partnerId64)}** con ${String(itemsToAttach.length)} item(s).`,
      color: Colors.Blue,
      fields: [{ name: '🎮 Items', value: sentItems }],
    });
  } catch (err) {
    console.error(`[delivery] Failed to update DB after offer ${idStr}:`, err);
    return await failRows(deliverableRowIds, {
      code: 'database_update_failed',
      message:
        'La oferta se creo, pero falle guardando el estado en la base de datos. Avisale a un admin antes de reintentar.'
    });
  }

  return {
    ok: true,
    code: 'sent',
    tradeOfferId: idStr,
    message:
      missing.length > 0
        ? 'Te mande una oferta con los premios que encontre. Algunos premios no estaban en el inventario tradable del bot y necesitan revision de un admin.'
        : 'Listo, te mande la oferta de intercambio. Revisala en Steam.'
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
