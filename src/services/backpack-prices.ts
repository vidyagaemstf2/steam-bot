import { env } from '@/env.ts';

const BPTF_API_BASE = 'https://backpack.tf/api';
const PRICES_TTL_MS = 900_000;
const KEYS_DEFINDEX = 5021;
const FALLBACK_KEY_PRICE_IN_METAL = 60;

export type PriceResult = {
  currency: 'keys' | 'metal';
  value: number;
  valueInMetal: number;
};

type V4PricesEntry = {
  currency: string;
  value: number;
  value_high?: number;
};

type V4ItemDoc = {
  prices: Record<string, Record<string, Record<string, Record<string, V4PricesEntry>>>>;
};

type V4PricesResponse = {
  success: number;
  items: Record<string, V4ItemDoc>;
};

type CurrencyEntry = {
  defindex?: number;
  price?: V4PricesEntry;
};

type CurrenciesResponse = {
  success: number;
  currencies?: Record<string, CurrencyEntry>;
};

const QUALITY_PREFIXES: Array<[string, number]> = [
  ["Strange ", 11],
  ["Genuine ", 1],
  ["Vintage ", 3],
  ["Unusual ", 5],
  ["Collector's ", 14],
  ["Haunted ", 13],
  ["Normal ", 0],
];
const UNIQUE_QUALITY = 6;

let cachedPrices: V4PricesResponse | null = null;
let keyPriceInMetal: number = FALLBACK_KEY_PRICE_IN_METAL;
let cacheExpiresAt = 0;
let fetchInProgress: Promise<void> | null = null;

async function fetchJson<T>(url: string): Promise<T> {
  const resp = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000)
  });
  if (!resp.ok) {
    throw new Error(`HTTP ${String(resp.status)} from ${url}`);
  }
  return resp.json() as Promise<T>;
}

async function loadPriceData(): Promise<void> {
  const apiKey = env.BACKPACK_TF_API_KEY;
  if (!apiKey) {
    return;
  }

  const [pricesData, currenciesData] = await Promise.allSettled([
    fetchJson<V4PricesResponse>(`${BPTF_API_BASE}/IGetPrices/v4?key=${encodeURIComponent(apiKey)}`),
    fetchJson<CurrenciesResponse>(`${BPTF_API_BASE}/IGetCurrencies/v1?key=${encodeURIComponent(apiKey)}`)
  ]);

  if (pricesData.status === 'fulfilled' && pricesData.value.success === 1) {
    cachedPrices = pricesData.value;
    cacheExpiresAt = Date.now() + PRICES_TTL_MS;
    console.log(
      `[backpack-prices] Price schema loaded (${String(Object.keys(pricesData.value.items ?? {}).length)} items).`
    );
  } else if (pricesData.status === 'rejected') {
    console.error('[backpack-prices] Failed to fetch price schema:', pricesData.reason);
  }

  if (currenciesData.status === 'fulfilled' && currenciesData.value.success === 1) {
    const currencies = currenciesData.value.currencies ?? {};
    for (const entry of Object.values(currencies)) {
      if (entry.defindex === KEYS_DEFINDEX && entry.price?.currency === 'metal') {
        keyPriceInMetal = entry.price.value;
        console.log(`[backpack-prices] Key price: ${String(keyPriceInMetal)} ref.`);
        break;
      }
    }
  }
}

async function ensurePriceCacheReady(): Promise<void> {
  if (cachedPrices !== null && Date.now() < cacheExpiresAt) {
    return;
  }
  if (!fetchInProgress) {
    fetchInProgress = loadPriceData().finally(() => {
      fetchInProgress = null;
    });
  }
  await fetchInProgress;
}

function parseItemQualityAndBase(itemName: string): { quality: number; baseName: string } {
  for (const [prefix, quality] of QUALITY_PREFIXES) {
    if (itemName.startsWith(prefix)) {
      return { quality, baseName: itemName.slice(prefix.length) };
    }
  }
  return { quality: UNIQUE_QUALITY, baseName: itemName };
}

function lookupInCache(itemName: string): PriceResult | null {
  if (!cachedPrices) return null;

  const { quality, baseName } = parseItemQualityAndBase(itemName);

  const itemDoc = cachedPrices.items[baseName];
  if (!itemDoc) return null;

  const qualityDoc = itemDoc.prices[String(quality)];
  if (!qualityDoc) return null;

  const tradable = qualityDoc['Tradable'];
  if (!tradable) return null;

  const craftable = tradable['Craftable'];
  if (!craftable) return null;

  const entry = craftable['0'];
  if (!entry) return null;

  const currency = entry.currency === 'keys' ? 'keys' : 'metal';
  const value = entry.value;
  const valueInMetal = currency === 'keys' ? value * keyPriceInMetal : value;

  return { currency, value, valueInMetal };
}

export async function lookupItemPrice(itemName: string): Promise<PriceResult | null> {
  if (!env.BACKPACK_TF_API_KEY) {
    return null;
  }
  try {
    await ensurePriceCacheReady();
  } catch (err) {
    console.error('[backpack-prices] Cache refresh error:', err instanceof Error ? err.message : String(err));
    return null;
  }
  return lookupInCache(itemName);
}

export async function warmPriceCache(): Promise<void> {
  if (!env.BACKPACK_TF_API_KEY) return;
  try {
    await ensurePriceCacheReady();
  } catch {
    // non-fatal on startup
  }
}
