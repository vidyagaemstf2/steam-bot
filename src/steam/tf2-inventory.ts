import type SteamCommunity from 'steamcommunity';
import type TradeOfferManager from 'steam-tradeoffer-manager';
import { TF2_APP_ID, TF2_CONTEXT_ID } from '@/steam/session.ts';

type EconTradable = { tradable?: boolean | number | string };

/**
 * Steam's inventory JSON splits stackables (TF2 metal) into a separate `currency` array.
 * Both arrays must be merged or trade offers cannot attach those items.
 */
export function mergeInventoryAndCurrency<T>(inventory: T[] | undefined, currency: T[] | undefined): T[] {
  return [...(inventory ?? []), ...(currency ?? [])];
}

/** CEconItem sets `tradable`; keep only items safe to put in a trade offer. */
export function filterTradableEconItems<T extends EconTradable>(items: T[]): T[] {
  return items.filter(
    (item) => item.tradable === true || item.tradable === 1 || item.tradable === '1'
  );
}

export async function loadTf2InventoryViaCommunity(
  community: SteamCommunity,
  steamId64: string,
  language: string = 'english'
): Promise<unknown[]> {
  return await new Promise((resolve, reject) => {
    community.getUserInventoryContents(
      steamId64,
      TF2_APP_ID,
      TF2_CONTEXT_ID,
      true,
      language,
      (err: Error | null, inventory?: unknown[], currency?: unknown[]) => {
        if (err) {
          reject(err);
        } else {
          const merged = mergeInventoryAndCurrency(
            inventory,
            currency
          ) as EconTradable[];
          resolve(filterTradableEconItems(merged));
        }
      }
    );
  });
}

export async function loadTf2InventoryViaOfferManager(manager: TradeOfferManager): Promise<unknown[]> {
  return await new Promise((resolve, reject) => {
    manager.getInventoryContents(
      TF2_APP_ID,
      TF2_CONTEXT_ID,
      true,
      (err: Error | null, inventory?: unknown[], currency?: unknown[]) => {
        if (err) {
          reject(err);
        } else {
          const merged = mergeInventoryAndCurrency(
            inventory,
            currency
          ) as EconTradable[];
          resolve(filterTradableEconItems(merged));
        }
      }
    );
  });
}
