import type SteamCommunity from 'steamcommunity';

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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Mobile confirmation for a trade offer (incoming accept or outgoing send), with retries.
 */
export async function confirmTradeOfferWithRetries(
  community: SteamCommunity,
  identitySecret: string,
  offerId: string,
  options?: { retries?: number; delayMs?: number; logPrefix?: string }
): Promise<void> {
  const retries = options?.retries ?? 3;
  const delayMs = options?.delayMs ?? 3000;
  const logPrefix = options?.logPrefix ?? '[steam-confirm]';

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      await confirmObjectOnce(community, identitySecret, offerId);
      return;
    } catch (err) {
      if (attempt < retries) {
        console.log(
          `${logPrefix} Confirmation attempt ${String(attempt)}/${String(retries)} failed for ${offerId}, retrying in ${String(delayMs / 1000)}s...`
        );
        await sleep(delayMs);
      } else {
        throw err;
      }
    }
  }
}
