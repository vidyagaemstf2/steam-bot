import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import SteamUser from 'steam-user';
import { listPendingDonationOffers, listPrizePoolItemsByAssetIds } from '@/db/donations.ts';
import {
  cancelDeliveriesByAssetIds,
  createPendingDelivery,
  findActiveDeliveryByAssetId,
  listActiveDeliveries,
  listReservedAssetIds
} from '@/db/pending-deliveries.ts';
import { env } from '@/env.ts';
import { triggerPrizeDelivery } from '@/services/delivery.ts';
import { cancelTradeOfferIfActive } from '@/services/offer-lifecycle.ts';
import { Colors, notify, steamProfileLink } from '@/utils/discord.ts';
import { approveDonationOffer, rejectDonationOffer } from '@/services/donations.ts';
import { resolvePersonaName } from '@/utils/persona.ts';
import type { SteamContext } from '@/steam/session.ts';
import { loadTf2InventoryViaCommunity } from '@/steam/tf2-inventory.ts';

export type InventoryItemJson = {
  assetId: string;
  name: string;
  donorSteamId?: string;
  donorName?: string;
  /** Omitted when `GET /inventory?minimal=1` (smaller JSON for fragile HTTP/2 clients). */
  imageUrl?: string;
  /** Value in keys. Present only when backpack.tf prices this item in keys. */
  priceKeys?: number;
  /** Value in refined metal. Present only when backpack.tf prices this item in metal. */
  priceMetal?: number;
  /** Which currency the price is expressed in. */
  priceCurrency?: 'keys' | 'metal';
};

type EconItem = {
  assetid?: string;
  id?: string;
  market_name?: string;
  name?: string;
  getImageURL: () => string;
};

let apiServer: http.Server | null = null;

function apiKeysEqual(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided, 'utf8').digest();
  const b = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(a, b);
}

function getProvidedApiKey(req: IncomingMessage): string | null {
  const raw = req.headers['x-bot-secret'];
  if (typeof raw === 'string' && raw.length > 0) {
    return raw;
  }
  if (Array.isArray(raw) && raw[0] !== undefined && raw[0].length > 0) {
    return raw[0];
  }

  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    const token = auth.slice(7).trim();
    return token.length > 0 ? token : null;
  }

  return null;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  req?: IncomingMessage
): void {
  const payload = JSON.stringify(body);
  const acceptsGzip =
    req !== undefined &&
    /\bgzip\b/.test(req.headers['accept-encoding']?.toString() ?? '');

  if (acceptsGzip) {
    const compressed = gzipSync(Buffer.from(payload, 'utf8'));
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Encoding': 'gzip',
      'Content-Length': compressed.length,
      Vary: 'Accept-Encoding'
    });
    res.end(compressed);
  } else {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(payload, 'utf8')
    });
    res.end(payload);
  }
}

const STEAM_ID64_RE = /^\d{17,19}$/;

function isValidSteamId64(s: string): boolean {
  return STEAM_ID64_RE.test(s);
}

function readJsonBody(req: IncomingMessage, maxBytes = 65536): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error('Body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.length === 0) {
        resolve(null);
        return;
      }
      try {
        resolve(JSON.parse(raw) as unknown);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function mapItem(item: EconItem): InventoryItemJson | null {
  const assetId = item.assetid ?? item.id;
  if (assetId === undefined || assetId === null) {
    return null;
  }
  const name = item.market_name ?? item.name ?? '';
  return {
    assetId: String(assetId).trim(),
    name,
    imageUrl: item.getImageURL()
  };
}

async function handleInventory(
  ctx: SteamContext,
  req: IncomingMessage,
  res: ServerResponse,
  minimal: boolean,
  includeReserved: boolean
): Promise<void> {
  const sid = ctx.user.steamID;
  if (!sid) {
    console.error('[api] Steam user has no steamID yet.');
    sendJson(res, 503, { error: 'Servicio no disponible' });
    return;
  }

  let reserved: Set<string>;
  try {
    const ids = await listReservedAssetIds();
    reserved = new Set(ids);
  } catch (err) {
    console.error('[api] Database error loading reserved assets:', err);
    sendJson(res, 502, { error: 'Error comunicandose con la base de datos' });
    return;
  }

  let items: EconItem[];
  try {
    items = (await loadTf2InventoryViaCommunity(
      ctx.community,
      sid.getSteamID64()
    )) as EconItem[];
  } catch (err) {
    console.error('[api] Steam inventory error:', err);
    sendJson(res, 502, { error: 'Error consultando el inventario de Steam' });
    return;
  }

  const available: InventoryItemJson[] = [];
  for (const item of items) {
    const assetId = String(item.assetid ?? item.id ?? '').trim();
    if (!assetId) {
      continue;
    }
    if (!includeReserved && reserved.has(assetId)) {
      continue;
    }
    const mapped = mapItem(item);
    if (mapped) {
      if (minimal) {
        available.push({ assetId: mapped.assetId, name: mapped.name });
      } else {
        available.push(mapped);
      }
    }
  }

  let priceInMetalByAsset = new Map<string, number>();
  try {
    const attributions = await listPrizePoolItemsByAssetIds(available.map((item) => item.assetId));
    const byAsset = new Map(attributions.map((item) => [item.asset_id, item]));
    for (const item of available) {
      const attribution = byAsset.get(item.assetId);
      if (attribution) {
        if (attribution.donor_steam_id) {
          item.donorSteamId = attribution.donor_steam_id;
        }
        if (attribution.donor_name) {
          item.donorName = attribution.donor_name;
        }
        if (attribution.price_keys != null) {
          item.priceKeys = attribution.price_keys;
          item.priceCurrency = 'keys';
        } else if (attribution.price_metal != null) {
          item.priceMetal = attribution.price_metal;
          item.priceCurrency = 'metal';
        }
        if (attribution.price_in_metal != null) {
          priceInMetalByAsset.set(item.assetId, attribution.price_in_metal);
        }
      }
    }
  } catch (err) {
    console.error('[api] Database error loading donation attribution:', err);
    priceInMetalByAsset = new Map();
  }

  available.sort((a, b) => {
    const aVal = priceInMetalByAsset.get(a.assetId) ?? -1;
    const bVal = priceInMetalByAsset.get(b.assetId) ?? -1;
    return bVal - aVal;
  });

  sendJson(res, 200, available, req);
}

function handleFriendStatus(ctx: SteamContext, res: ServerResponse, steamId64: string): void {
  if (!isValidSteamId64(steamId64)) {
    sendJson(res, 400, { error: 'SteamID64 invalido' });
    return;
  }
  const isFriend = ctx.user.myFriends[steamId64] === SteamUser.EFriendRelationship.Friend;
  sendJson(res, 200, { isFriend });
}

async function handleDeliveryTrigger(
  ctx: SteamContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Cuerpo invalido' });
    return;
  }
  if (body === null || typeof body !== 'object' || !('steamId64' in body)) {
    sendJson(res, 400, { error: 'Falta steamId64' });
    return;
  }
  const steamId64 = (body as { steamId64?: unknown }).steamId64;
  if (typeof steamId64 !== 'string' || !isValidSteamId64(steamId64)) {
    sendJson(res, 400, { error: 'SteamID64 invalido' });
    return;
  }
  triggerPrizeDelivery(ctx, steamId64);
  sendJson(res, 202, { ok: true, queued: true });
}

async function handleDeliveryRecord(
  ctx: SteamContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Cuerpo invalido' });
    return;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, { error: 'Cuerpo invalido' });
    return;
  }

  const { steamId64, assetId, itemName } = body as Record<string, unknown>;

  if (typeof steamId64 !== 'string' || !isValidSteamId64(steamId64)) {
    sendJson(res, 400, { error: 'SteamID64 invalido' });
    return;
  }
  if (typeof assetId !== 'string' || assetId.trim().length === 0) {
    sendJson(res, 400, { error: 'assetId invalido' });
    return;
  }
  if (typeof itemName !== 'string' || itemName.trim().length === 0) {
    sendJson(res, 400, { error: 'itemName invalido' });
    return;
  }

  const expiresAt = new Date(Date.now() + env.MANUAL_DELIVERY_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  try {
    const conflict = await findActiveDeliveryByAssetId(assetId.trim());
    if (conflict && conflict.winner_steam_id !== steamId64) {
      sendJson(res, 409, {
        error: `Asset ${assetId.trim()} ya está reservado para otro ganador (${conflict.winner_steam_id})`
      });
      return;
    }
    await createPendingDelivery(steamId64, assetId.trim(), itemName.trim(), expiresAt);
  } catch (err) {
    console.error('[api] Failed to record delivery:', err);
    sendJson(res, 500, { error: 'No se pudo registrar la entrega' });
    return;
  }

  const isFriend = ctx.user.myFriends[steamId64] === SteamUser.EFriendRelationship.Friend;
  if (isFriend) {
    triggerPrizeDelivery(ctx, steamId64);
  }

  const winnerLabel = await resolvePersonaNameAsync(ctx, steamId64);
  void notify('admin', {
    title: '🎉 Premio asignado',
    description: `**${steamProfileLink(winnerLabel, steamId64)}** ganó **${itemName.trim()}**.`,
    color: Colors.Green,
    fields: [
      { name: 'Expira', value: expiresAt.toISOString().slice(0, 10), inline: true },
      {
        name: 'Estado',
        value: isFriend ? 'Oferta en cola' : 'Esperando que agregue al bot',
        inline: true
      }
    ]
  });

  sendJson(res, 201, { recorded: true, isFriend, deliveryQueued: isFriend });
}

async function handleAdminSend(
  ctx: SteamContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Cuerpo invalido' });
    return;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, { error: 'Cuerpo invalido' });
    return;
  }

  const { winnerSteamId, items, isGiveawayBundle } = body as Record<string, unknown>;

  if (typeof winnerSteamId !== 'string' || !isValidSteamId64(winnerSteamId)) {
    sendJson(res, 400, { error: 'winnerSteamId invalido' });
    return;
  }
  if (!Array.isArray(items) || items.length === 0) {
    sendJson(res, 400, { error: 'items debe ser un array no vacio' });
    return;
  }
  for (const item of items as unknown[]) {
    if (
      item === null ||
      typeof item !== 'object' ||
      typeof (item as Record<string, unknown>).assetId !== 'string' ||
      ((item as Record<string, unknown>).assetId as string).trim().length === 0 ||
      typeof (item as Record<string, unknown>).itemName !== 'string' ||
      ((item as Record<string, unknown>).itemName as string).trim().length === 0
    ) {
      sendJson(res, 400, { error: 'Cada item debe tener assetId e itemName no vacios' });
      return;
    }
  }

  const expiryDays = env.MANUAL_DELIVERY_EXPIRY_DAYS;
  const expiresAt = new Date(Date.now() + expiryDays * 24 * 60 * 60 * 1000);

  const typedItems = items as Record<string, unknown>[];

  for (const raw of typedItems) {
    const assetId = (raw.assetId as string).trim();
    try {
      const conflict = await findActiveDeliveryByAssetId(assetId);
      if (conflict && conflict.winner_steam_id !== winnerSteamId) {
        sendJson(res, 409, {
          error: `Asset ${assetId} ya está reservado para otro ganador (${conflict.winner_steam_id})`
        });
        return;
      }
    } catch (err) {
      console.error(`[api] Failed to check reservation for asset ${assetId}:`, err);
      sendJson(res, 500, { error: 'No se pudo verificar la disponibilidad del item' });
      return;
    }
  }

  try {
    for (const raw of typedItems) {
      await createPendingDelivery(
        winnerSteamId,
        (raw.assetId as string).trim(),
        (raw.itemName as string).trim(),
        expiresAt
      );
    }
  } catch (err) {
    console.error('[api] Failed to record admin delivery:', err);
    sendJson(res, 500, { error: 'No se pudo registrar la entrega' });
    return;
  }

  const isFriend = ctx.user.myFriends[winnerSteamId] === SteamUser.EFriendRelationship.Friend;
  if (isFriend) {
    triggerPrizeDelivery(ctx, winnerSteamId);
  }

  const adminSendWinnerLabel = await resolvePersonaName(ctx, winnerSteamId);
  const bundleGiveaway = isGiveawayBundle === true;
  void notify('admin', {
    title: bundleGiveaway ? '🎉 Bundle ganado' : '📦 Entrega manual encolada',
    description: bundleGiveaway
      ? `**${steamProfileLink(adminSendWinnerLabel, winnerSteamId)}** ganó un bundle de **${String(items.length)} ítem(s)** en el sorteo.`
      : `${String(items.length)} ítem(s) encolado(s) para ${steamProfileLink(adminSendWinnerLabel, winnerSteamId)}. Expira ${expiresAt.toISOString().slice(0, 10)}.`,
    color: bundleGiveaway ? Colors.Green : Colors.Blue,
    fields: (items as Record<string, unknown>[]).map((it) => ({
      name: (it.itemName as string).trim(),
      value: (it.assetId as string).trim(),
      inline: true
    }))
  });

  sendJson(res, 201, {
    recorded: true,
    count: items.length,
    isFriend,
    deliveryQueued: isFriend
  });
}

async function handleDeliveryActive(
  ctx: SteamContext,
  res: ServerResponse,
  req: IncomingMessage
): Promise<void> {
  let rows: Awaited<ReturnType<typeof listActiveDeliveries>>;
  try {
    rows = await listActiveDeliveries();
  } catch (err) {
    console.error('[api] Failed to list active deliveries:', err);
    sendJson(res, 500, { error: 'No se pudieron listar las entregas activas' });
    return;
  }

  const mapped = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      winnerSteamId: row.winner_steam_id,
      winnerName: await resolvePersonaName(ctx, row.winner_steam_id),
      assetId: row.asset_id,
      itemName: row.item_name,
      status: row.status,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      tradeOfferId: row.trade_offer_id
    }))
  );
  sendJson(res, 200, mapped, req);
}

async function handleDeliveryRevoke(
  ctx: SteamContext,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Cuerpo invalido' });
    return;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, { error: 'Cuerpo invalido' });
    return;
  }

  const obj = body as Record<string, unknown>;
  const { assetId, action, targetSteamId, adminSteamId, adminName } = obj;

  if (typeof assetId !== 'string' || assetId.trim().length === 0) {
    sendJson(res, 400, { error: 'assetId invalido' });
    return;
  }
  if (action !== 'return_to_pool' && action !== 'reassign') {
    sendJson(res, 400, { error: 'action debe ser return_to_pool o reassign' });
    return;
  }
  if (action === 'reassign') {
    if (typeof targetSteamId !== 'string' || !isValidSteamId64(targetSteamId)) {
      sendJson(res, 400, { error: 'targetSteamId invalido para reassign' });
      return;
    }
  }

  const normalizedAssetId = (assetId as string).trim();

  let active: Awaited<ReturnType<typeof findActiveDeliveryByAssetId>>;
  try {
    active = await findActiveDeliveryByAssetId(normalizedAssetId);
  } catch (err) {
    console.error('[api] Failed to look up active delivery for revoke:', err);
    sendJson(res, 500, { error: 'Error consultando la base de datos' });
    return;
  }

  if (!active) {
    sendJson(res, 404, { error: 'No se encontro una entrega activa para ese asset' });
    return;
  }

  if (active.status === 'offer_sent' && active.trade_offer_id) {
    await cancelTradeOfferIfActive(ctx.tradeOfferManager, active.trade_offer_id);
  }

  try {
    await cancelDeliveriesByAssetIds([normalizedAssetId]);
  } catch (err) {
    console.error('[api] Failed to cancel delivery during revoke:', err);
    sendJson(res, 500, { error: 'Error cancelando la entrega en la base de datos' });
    return;
  }

  let newWinnerName: string | undefined;

  if (action === 'reassign' && typeof targetSteamId === 'string') {
    try {
      await createPendingDelivery(targetSteamId, normalizedAssetId, active.item_name);
    } catch (err) {
      console.error('[api] Failed to create reassigned delivery:', err);
      sendJson(res, 500, { error: 'Se cancelo la entrega pero fallo la reasignacion' });
      return;
    }
    newWinnerName = await resolvePersonaName(ctx, targetSteamId);
    const isFriend = ctx.user.myFriends[targetSteamId] === SteamUser.EFriendRelationship.Friend;
    if (isFriend) {
      triggerPrizeDelivery(ctx, targetSteamId);
    }
  }

  const adminLabel =
    typeof adminName === 'string' && adminName.trim() ? adminName.trim() : 'admin desconocido';
  const adminIdStr =
    typeof adminSteamId === 'string' && isValidSteamId64(adminSteamId) ? adminSteamId : null;
  const adminDisplay = adminIdStr ? steamProfileLink(adminLabel, adminIdStr) : adminLabel;
  const prevWinnerLabel = await resolvePersonaName(ctx, active.winner_steam_id);

  if (action === 'reassign' && typeof targetSteamId === 'string') {
    void notify('admin', {
      title: '🔄 Premio reasignado',
      description: `**${adminDisplay}** reasignó **${active.item_name}** de ${steamProfileLink(prevWinnerLabel, active.winner_steam_id)} a ${steamProfileLink(newWinnerName ?? targetSteamId, targetSteamId)}.`,
      color: Colors.Blue,
      fields: [{ name: 'Asset ID', value: normalizedAssetId }]
    });
  } else {
    void notify('admin', {
      title: '↩️ Premio devuelto al pool',
      description: `**${adminDisplay}** revocó la entrega de **${active.item_name}** a ${steamProfileLink(prevWinnerLabel, active.winner_steam_id)} y lo devolvió al pool.`,
      color: Colors.Yellow,
      fields: [{ name: 'Asset ID', value: normalizedAssetId }]
    });
  }

  sendJson(res, 200, {
    ok: true,
    assetId: normalizedAssetId,
    itemName: active.item_name,
    previousWinnerSteamId: active.winner_steam_id,
    ...(newWinnerName !== undefined ? { newWinnerName } : {})
  });
}

async function handlePendingDonations(res: ServerResponse, req: IncomingMessage): Promise<void> {
  try {
    const offers = await listPendingDonationOffers();
    sendJson(
      res,
      200,
      offers.map((offer) => ({
        tradeOfferId: offer.trade_offer_id,
        donorSteamId: offer.donor_steam_id,
        donorName: offer.donor_name,
        message: offer.message,
        createdAt: offer.created_at,
        items: offer.items.map((item) => ({
          assetId: item.asset_id,
          name: item.name,
          appId: item.app_id,
          contextId: item.context_id,
          iconUrl: item.icon_url
        }))
      })),
      req
    );
  } catch (err) {
    console.error('[api] Failed to list pending donations:', err);
    sendJson(res, 500, { error: 'No se pudieron listar las donaciones pendientes' });
  }
}

async function handleDonationReview(
  ctx: SteamContext,
  req: IncomingMessage,
  res: ServerResponse,
  tradeOfferId: string,
  approve: boolean
): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Cuerpo invalido' });
    return;
  }

  const obj = body !== null && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const reviewerSteamId =
    typeof obj.reviewerSteamId === 'string' && isValidSteamId64(obj.reviewerSteamId)
      ? obj.reviewerSteamId
      : null;
  const reviewerName =
    typeof obj.reviewerName === 'string' && obj.reviewerName.trim()
      ? obj.reviewerName.trim()
      : null;
  const note = typeof obj.note === 'string' && obj.note.trim() ? obj.note.trim() : null;

  try {
    if (approve) {
      const summary = await approveDonationOffer(ctx, tradeOfferId, { reviewerSteamId, reviewerName, note });
      sendJson(res, 200, { ok: true, approved: true, ...summary });
    } else {
      await rejectDonationOffer(ctx, tradeOfferId, { reviewerSteamId, reviewerName, note });
      sendJson(res, 200, { ok: true, rejected: true });
    }
  } catch (err) {
    console.error(`[api] Donation ${approve ? 'approve' : 'reject'} failed:`, err);
    sendJson(res, 409, { error: err instanceof Error ? err.message : 'Fallo la revision de la donacion' });
  }
}

async function handleRequest(ctx: SteamContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  const provided = getProvidedApiKey(req);
  if (provided === null || !apiKeysEqual(provided, env.API_SECRET)) {
    sendJson(res, 401, { error: 'No autorizado' });
    return;
  }

  if (req.method === 'GET' && pathname === '/inventory') {
    const minimal = url.searchParams.get('minimal') === '1';
    const includeReserved = url.searchParams.get('includeReserved') === '1';
    await handleInventory(ctx, req, res, minimal, includeReserved);
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/friend-status/')) {
    const steamId64 = pathname.slice('/friend-status/'.length);
    handleFriendStatus(ctx, res, steamId64);
    return;
  }

  if (req.method === 'POST' && pathname === '/delivery/trigger') {
    await handleDeliveryTrigger(ctx, req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/delivery/record') {
    await handleDeliveryRecord(ctx, req, res);
    return;
  }

  if (req.method === 'POST' && pathname === '/delivery/admin-send') {
    await handleAdminSend(ctx, req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/delivery/active') {
    await handleDeliveryActive(ctx, res, req);
    return;
  }

  if (req.method === 'POST' && pathname === '/delivery/revoke') {
    await handleDeliveryRevoke(ctx, req, res);
    return;
  }

  if (req.method === 'GET' && pathname === '/donations/pending') {
    await handlePendingDonations(res, req);
    return;
  }

  const donationReview = pathname.match(/^\/donations\/([^/]+)\/(approve|reject)$/);
  if (req.method === 'POST' && donationReview) {
    const tradeOfferId = decodeURIComponent(donationReview[1] ?? '');
    if (!tradeOfferId) {
      sendJson(res, 400, { error: 'Falta tradeOfferId' });
      return;
    }
    await handleDonationReview(ctx, req, res, tradeOfferId, donationReview[2] === 'approve');
    return;
  }

  sendJson(res, 404, { error: 'No encontrado' });
}

/**
 * Starts the HTTP API (call only after Steam `webSession` is ready).
 */
export function startApiServer(ctx: SteamContext): Promise<void> {
  if (apiServer) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleRequest(ctx, req, res).catch((err: unknown) => {
        console.error('[api] Unhandled request error:', err);
        if (!res.writableEnded) {
          sendJson(res, 500, { error: 'Error interno del servidor' });
        }
      });
    });

    const onEarlyError = (err: Error): void => {
      reject(err);
    };
    server.once('error', onEarlyError);

    server.listen(env.API_PORT, env.API_HOST, () => {
      server.off('error', onEarlyError);
      server.on('error', (err) => {
        console.error('[api] HTTP server error:', err.message);
      });
      apiServer = server;
      console.log(
        `[api] Listening on http://${env.API_HOST}:${String(env.API_PORT)} — GET /inventory, GET /friend-status/:steamId64, POST /delivery/trigger, POST /delivery/record, POST /delivery/admin-send, GET /delivery/active, POST /delivery/revoke`
      );
      resolve();
    });
  });
}

export function stopApiServer(): Promise<void> {
  const server = apiServer;
  if (!server) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    server.close((err) => {
      if (err) {
        console.error('[api] HTTP server close error:', err.message);
      } else {
        console.log('[api] HTTP server closed.');
      }
      apiServer = null;
      resolve();
    });
  });
}
