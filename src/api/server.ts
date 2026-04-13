import { createHash, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { listReservedAssetIds } from '@/db/pending-deliveries.ts';
import { env } from '@/env.ts';
import type { SteamContext } from '@/steam/session.ts';
import { TF2_APP_ID, TF2_CONTEXT_ID } from '@/steam/session.ts';

export type InventoryItemJson = {
  assetId: string;
  name: string;
  imageUrl: string;
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

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload, 'utf8')
  });
  res.end(payload);
}

function loadTf2Inventory(community: SteamContext['community'], steamId64: string): Promise<EconItem[]> {
  return new Promise((resolve, reject) => {
    community.getUserInventoryContents(
      steamId64,
      TF2_APP_ID,
      TF2_CONTEXT_ID,
      true,
      'english',
      (err: Error | null, inventory?: EconItem[]) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(inventory ?? []);
      }
    );
  });
}

function mapItem(item: EconItem): InventoryItemJson | null {
  const assetId = item.assetid ?? item.id;
  if (assetId === undefined || assetId === null) {
    return null;
  }
  const name = item.market_name ?? item.name ?? '';
  return {
    assetId: String(assetId),
    name,
    imageUrl: item.getImageURL()
  };
}

async function handleInventory(ctx: SteamContext, res: ServerResponse): Promise<void> {
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
    items = await loadTf2Inventory(ctx.community, sid.getSteamID64());
  } catch (err) {
    console.error('[api] Steam inventory error:', err);
    sendJson(res, 502, { error: 'Bad gateway' });
    return;
  }

  const out: InventoryItemJson[] = [];
  for (const item of items) {
    const assetId = String(item.assetid ?? item.id ?? '');
    if (!assetId || reserved.has(assetId)) {
      continue;
    }
    const mapped = mapItem(item);
    if (mapped) {
      out.push(mapped);
    }
  }

  sendJson(res, 200, out);
}

async function handleRequest(ctx: SteamContext, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
  if (pathname !== '/inventory') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  const provided = getProvidedApiKey(req);
  if (provided === null || !apiKeysEqual(provided, env.API_SECRET)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }

  await handleInventory(ctx, res);
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
      console.log(`[api] Listening on http://${env.API_HOST}:${String(env.API_PORT)}`);
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
