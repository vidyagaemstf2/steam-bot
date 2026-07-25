export type BotInventoryItem = {
  assetId: string;
  name: string;
};

const BOT_API_BASE = 'http://149.50.130.122:52381';
const BOT_API_SECRET = 'g3PDInwH9/gvEEZCNZL3ix7BbjWpIXQ2n16IPBSlyKo=';

/**
 * Same inventory source as sm_gstart (GET /inventory?minimal=1 via the bot HTTP API).
 * When includeReserved is true, items tied to pending deliveries are included (for reconciliation).
 */
export async function fetchBotInventoryViaApi(
  includeReserved = false
): Promise<BotInventoryItem[]> {
  const params = new URLSearchParams({ minimal: '1' });
  if (includeReserved) {
    params.set('includeReserved', '1');
  }

  const url = `${BOT_API_BASE}/inventory?${params.toString()}`;
  const resp = await fetch(url, {
    headers: {
      'X-Bot-Secret': BOT_API_SECRET,
      Accept: 'application/json',
      'Accept-Encoding': 'gzip'
    },
    signal: AbortSignal.timeout(30_000)
  });

  if (!resp.ok) {
    let detail = '';
    try {
      const errBody = (await resp.json()) as { error?: string };
      if (errBody.error) {
        detail = `: ${errBody.error}`;
      }
    } catch {
      // ignore parse errors
    }
    throw new Error(`Bot inventory API returned HTTP ${String(resp.status)}${detail}`);
  }

  const data: unknown = await resp.json();
  if (!Array.isArray(data)) {
    throw new Error('Bot inventory API returned non-array JSON');
  }

  const items: BotInventoryItem[] = [];
  for (const el of data) {
    if (el === null || typeof el !== 'object') {
      continue;
    }
    const obj = el as Record<string, unknown>;
    const assetId = typeof obj.assetId === 'string' ? obj.assetId.trim() : '';
    const name = typeof obj.name === 'string' ? obj.name.trim() : '';
    if (assetId.length > 0 && name.length > 0) {
      items.push({ assetId, name });
    }
  }

  return items;
}
