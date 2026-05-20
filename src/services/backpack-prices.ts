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

type V4CraftableEntry = V4PricesEntry[];

type V4ItemDoc = {
  prices: Record<string, Record<string, Record<string, V4CraftableEntry>>>;
};

type V4PricesResponse = {
  success: number;
  items: Record<string, V4ItemDoc>;
};

type V4PricesEnvelope = {
  response?: V4PricesResponse;
} & Partial<V4PricesResponse>;

type CurrencyEntry = {
  defindex?: number;
  price?: V4PricesEntry;
};

type CurrenciesBody = {
  success: number;
  currencies?: Record<string, CurrencyEntry> | CurrencyEntry[];
};

type CurrenciesEnvelope = {
  response?: CurrenciesBody;
} & Partial<CurrenciesBody>;

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

function unwrapPrices(raw: V4PricesEnvelope): V4PricesResponse | null {
  const body = raw.response ?? (raw as V4PricesResponse);
  if (typeof body !== 'object' || body === null) return null;
  if (body.success !== 1) {
    console.error('[backpack-prices] Price schema returned success=0');
    return null;
  }
  if (!body.items || typeof body.items !== 'object') {
    console.error('[backpack-prices] Price schema response missing items object');
    return null;
  }
  return body;
}

function unwrapCurrencies(raw: CurrenciesEnvelope): CurrenciesBody | null {
  const body = raw.response ?? (raw as CurrenciesBody);
  if (typeof body !== 'object' || body === null) return null;
  return body.success === 1 ? body : null;
}

async function loadPriceData(): Promise<void> {
  const apiKey = env.BACKPACK_TF_API_KEY;
  if (!apiKey) {
    console.warn('[backpack-prices] BACKPACK_TF_API_KEY is not set; pricing unavailable.');
    return;
  }

  const [pricesData, currenciesData] = await Promise.allSettled([
    fetchJson<V4PricesEnvelope>(`${BPTF_API_BASE}/IGetPrices/v4?key=${encodeURIComponent(apiKey)}`),
    fetchJson<CurrenciesEnvelope>(`${BPTF_API_BASE}/IGetCurrencies/v1?key=${encodeURIComponent(apiKey)}`)
  ]);

  if (pricesData.status === 'rejected') {
    console.error('[backpack-prices] Failed to fetch price schema:', pricesData.reason);
  } else {
    const prices = unwrapPrices(pricesData.value);
    if (prices) {
      cachedPrices = prices;
      cacheExpiresAt = Date.now() + PRICES_TTL_MS;
      console.log(
        `[backpack-prices] Price schema loaded (${String(Object.keys(prices.items).length)} items).`
      );
    }
  }

  if (currenciesData.status === 'rejected') {
    console.error('[backpack-prices] Failed to fetch currencies:', currenciesData.reason);
  } else {
    const currencies = unwrapCurrencies(currenciesData.value);
    if (currencies?.currencies) {
      const entries = Array.isArray(currencies.currencies)
        ? currencies.currencies
        : Object.values(currencies.currencies);
      for (const entry of entries) {
        if (entry.defindex === KEYS_DEFINDEX && entry.price?.currency === 'metal') {
          keyPriceInMetal = entry.price.value;
          console.log(`[backpack-prices] Key price: ${String(keyPriceInMetal)} ref.`);
          break;
        }
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

function stripThe(name: string): string {
  return name.startsWith('The ') ? name.slice(4) : name;
}

function buildCandidates(itemName: string): Array<[string, number]> {
  const candidates: Array<[string, number]> = [];

  // Always try the exact name (and without "The ") as Unique quality first.
  // This handles items whose name starts with a quality word that is actually
  // part of the name (e.g. "Vintage Tyrolean" is Unique quality, not Vintage quality).
  candidates.push([itemName, UNIQUE_QUALITY]);
  const withoutThe = stripThe(itemName);
  if (withoutThe !== itemName) {
    candidates.push([withoutThe, UNIQUE_QUALITY]);
  }

  // Then try stripping a known quality prefix and using the matching quality.
  for (const [prefix, quality] of QUALITY_PREFIXES) {
    if (itemName.startsWith(prefix)) {
      const base = itemName.slice(prefix.length);
      candidates.push([base, quality]);
      const baseWithoutThe = stripThe(base);
      if (baseWithoutThe !== base) {
        candidates.push([baseWithoutThe, quality]);
      }
      break;
    }
  }

  return candidates;
}

function priceEntryFromDoc(
  itemDoc: V4ItemDoc,
  quality: number
): V4PricesEntry | null {
  const qualityDoc = itemDoc.prices[String(quality)];
  if (!qualityDoc) return null;
  const tradable = qualityDoc['Tradable'];
  if (!tradable) return null;
  const craftable = tradable['Craftable'];
  if (!craftable) return null;
  return craftable[0] ?? null;
}

function lookupInCache(itemName: string): PriceResult | null {
  if (!cachedPrices) return null;

  for (const [baseName, quality] of buildCandidates(itemName)) {
    const itemDoc = cachedPrices.items[baseName];
    if (!itemDoc) continue;

    const entry = priceEntryFromDoc(itemDoc, quality);
    if (!entry) continue;

    const currency = entry.currency === 'keys' ? 'keys' : 'metal';
    const value =
      entry.value_high != null ? (entry.value + entry.value_high) / 2 : entry.value;
    const valueInMetal = currency === 'keys' ? value * keyPriceInMetal : value;
    return { currency, value, valueInMetal };
  }

  return null;
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
