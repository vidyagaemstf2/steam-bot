import type SteamCommunity from 'steamcommunity';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const DEFAULT_RETRIES = 5;
const DEFAULT_BASE_DELAY_MS = 5_000;
const RATE_LIMIT_BASE_DELAY_MS = 15_000;
const MAX_DELAY_MS = 120_000;
const MIN_GAP_BETWEEN_CONFIRMS_MS = 5_000;
const INITIAL_DELAY_MS = 2_000;

let confirmChain: Promise<void> = Promise.resolve();
let lastConfirmStartedAt = 0;

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

export function isSteamRateLimitError(err: unknown): boolean {
  const text = errorText(err).toLowerCase();
  if (text.includes('429') || text.includes('too many requests') || text.includes('rate limit')) {
    return true;
  }
  if (err !== null && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (code === 429 || code === '429') {
      return true;
    }
  }
  return false;
}

function backoffDelayMs(attempt: number, rateLimited: boolean, baseDelayMs: number): number {
  const base = rateLimited ? Math.max(baseDelayMs, RATE_LIMIT_BASE_DELAY_MS) : baseDelayMs;
  const exp = Math.min(MAX_DELAY_MS, base * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * 1_000);
  return exp + jitter;
}

function confirmObjectOnce(
  community: SteamCommunity,
  identitySecret: string,
  offerId: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    community.acceptConfirmationForObject(identitySecret, offerId, (err: Error | null) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function waitForConfirmSlot(): Promise<void> {
  const elapsed = Date.now() - lastConfirmStartedAt;
  const waitMs = Math.max(0, MIN_GAP_BETWEEN_CONFIRMS_MS - elapsed);
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  lastConfirmStartedAt = Date.now();
}

/**
 * Mobile confirmation for a trade offer (incoming accept or outgoing send), with retries.
 * Confirmations are serialized process-wide so concurrent deliveries do not stampede Steam.
 */
export async function confirmTradeOfferWithRetries(
  community: SteamCommunity,
  identitySecret: string,
  offerId: string,
  options?: { retries?: number; delayMs?: number; logPrefix?: string }
): Promise<void> {
  const run = async (): Promise<void> => {
    const retries = options?.retries ?? DEFAULT_RETRIES;
    const baseDelayMs = options?.delayMs ?? DEFAULT_BASE_DELAY_MS;
    const logPrefix = options?.logPrefix ?? '[steam-confirm]';

    if (INITIAL_DELAY_MS > 0) {
      await sleep(INITIAL_DELAY_MS);
    }

    let sawRateLimit = false;

    for (let attempt = 1; attempt <= retries; attempt++) {
      await waitForConfirmSlot();
      try {
        await confirmObjectOnce(community, identitySecret, offerId);
        return;
      } catch (err) {
        const rateLimited = isSteamRateLimitError(err);
        if (rateLimited) {
          sawRateLimit = true;
        }

        if (attempt >= retries) {
          throw err;
        }

        const delayMs = backoffDelayMs(attempt, sawRateLimit || rateLimited, baseDelayMs);
        console.log(
          `${logPrefix} Confirmation attempt ${String(attempt)}/${String(retries)} failed for ${offerId}` +
            `${rateLimited ? ' (rate limited)' : ''}: ${errorText(err)}; retrying in ${String(Math.round(delayMs / 1000))}s...`
        );
        await sleep(delayMs);
      }
    }
  };

  const queued = confirmChain.then(run, run);
  confirmChain = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}
