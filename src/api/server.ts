import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import SteamUser from 'steam-user';
import { createPendingDelivery, listReservedAssetIds } from '@/db/pending-deliveries.ts';
import { env } from '@/env.ts';
import { triggerPrizeDelivery } from '@/services/delivery.ts';
import type { SteamContext } from '@/steam/session.ts';
import { loadTf2InventoryViaCommunity } from '@/steam/tf2-inventory.ts';

export type InventoryItemJson = {
  assetId: string;
  name: string;
  /** Omitted when `GET /inventory?minimal=1` (smaller JSON for fragile HTTP/2 clients). */
  imageUrl?: string;
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
  minimal: boolean
): Promise<void> {
  const sid = ctx.user.steamID;
  if (!sid) {
    console.error('[api] Steam user has no steamID yet.');
    sendJson(res, 503, { error: 'Service unavailable' });
    return;
  }

  let reserved: Set<string>;
  try {
    const ids = await listReservedAssetIds();
    reserved = new Set(ids);
  } catch (err) {
    console.error('[api] Database error loading reserved assets:', err);
    sendJson(res, 502, { error: 'Bad gateway' });
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
    sendJson(res, 502, { error: 'Bad gateway' });
    return;
  }

  const out: InventoryItemJson[] = [];
  for (const item of items) {
    const assetId = String(item.assetid ?? item.id ?? '').trim();
    if (!assetId || reserved.has(assetId)) {
      continue;
    }
    const mapped = mapItem(item);
    if (mapped) {
      if (minimal) {
        out.push({ assetId: mapped.assetId, name: mapped.name });
      } else {
        out.push(mapped);
      }
    }
  }

  sendJson(res, 200, out, req);
}

function handleFriendStatus(ctx: SteamContext, res: ServerResponse, steamId64: string): void {
  if (!isValidSteamId64(steamId64)) {
    sendJson(res, 400, { error: 'Invalid steamId64' });
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
    sendJson(res, 400, { error: 'Invalid body' });
    return;
  }
  if (body === null || typeof body !== 'object' || !('steamId64' in body)) {
    sendJson(res, 400, { error: 'Missing steamId64' });
    return;
  }
  const steamId64 = (body as { steamId64?: unknown }).steamId64;
  if (typeof steamId64 !== 'string' || !isValidSteamId64(steamId64)) {
    sendJson(res, 400, { error: 'Invalid steamId64' });
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
    sendJson(res, 400, { error: 'Invalid body' });
    return;
  }
  if (body === null || typeof body !== 'object') {
    sendJson(res, 400, { error: 'Invalid body' });
    return;
  }

  const { steamId64, assetId, itemName } = body as Record<string, unknown>;

  if (typeof steamId64 !== 'string' || !isValidSteamId64(steamId64)) {
    sendJson(res, 400, { error: 'Invalid steamId64' });
    return;
  }
  if (typeof assetId !== 'string' || assetId.trim().length === 0) {
    sendJson(res, 400, { error: 'Invalid assetId' });
    return;
  }
  if (typeof itemName !== 'string' || itemName.trim().length === 0) {
    sendJson(res, 400, { error: 'Invalid itemName' });
    return;
  }

  try {
    await createPendingDelivery(steamId64, assetId.trim(), itemName.trim());
  } catch (err) {
    console.error('[api] Failed to record delivery:', err);
    sendJson(res, 500, { error: 'Failed to record delivery' });
    return;
  }

  const isFriend = ctx.user.myFriends[steamId64] === SteamUser.EFriendRelationship.Friend;
  if (isFriend) {
    triggerPrizeDelivery(ctx, steamId64);
  }

  sendJson(res, 201, { recorded: true, isFriend, deliveryQueued: isFriend });
}

async function handleRequest(ctx: SteamContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  const provided = getProvidedApiKey(req);
  if (provided === null || !apiKeysEqual(provided, env.API_SECRET)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  if (req.method === 'GET' && pathname === '/inventory') {
    const minimal = url.searchParams.get('minimal') === '1';
    await handleInventory(ctx, req, res, minimal);
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

  sendJson(res, 404, { error: 'Not found' });
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
          sendJson(res, 500, { error: 'Internal server error' });
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
        `[api] Listening on http://${env.API_HOST}:${String(env.API_PORT)} — GET /inventory, GET /friend-status/:steamId64, POST /delivery/trigger, POST /delivery/record`
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
