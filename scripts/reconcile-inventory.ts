/**
 * Compares the bot inventory returned by GET /inventory (same path as sm_gstart)
 * with prize_pool_items in the database and reports drift.
 *
 * Run:
 *   bun scripts/reconcile-inventory.ts          (check only)
 *   bun scripts/reconcile-inventory.ts --apply  (fix drift: register missing, delete stale,
 *                                                fix names, price unpriced rows)
 *
 * Requires the bot process to be running with a live Steam session.
 * Exit code 1 when reconciliation is needed (or was just applied).
 */
import { prisma } from '@/db.ts';
import { env } from '@/env.ts';
import {
  deletePrizePoolItemsByAssetIds,
  updatePrizePoolItemPrice,
  upsertPrizePoolItemDirect
} from '@/db/donations.ts';
import { lookupItemPrice, warmPriceCache } from '@/services/backpack-prices.ts';
import { fetchBotInventoryViaApi } from './lib/bot-api-inventory.ts';

const apply = process.argv.includes('--apply');

function printSection(title: string, lines: string[]): void {
  console.log(`\n[reconcile-inventory] ${title} (${String(lines.length)})`);
  if (lines.length === 0) {
    console.log('  (none)');
    return;
  }
  for (const line of lines) {
    console.log(`  - ${line}`);
  }
}

async function main(): Promise<void> {
  await prisma.$connect();
  console.log('[reconcile-inventory] Connected to database.');

  if (apply) {
    console.log('[reconcile-inventory] --apply mode: will fix drift.');
  }

  console.log(
    '[reconcile-inventory] Fetching inventory via bot API (GET /inventory?minimal=1&includeReserved=1).'
  );
  const botItems = await fetchBotInventoryViaApi(true);
  const botByAsset = new Map(botItems.map((item) => [item.assetId, item.name]));

  const dbRows = await prisma.prizePoolItem.findMany({
    select: { asset_id: true, item_name: true, priced_at: true }
  });
  const dbByAsset = new Map(dbRows.map((row) => [row.asset_id, row]));

  const inBotNotInDb = botItems.filter((item) => !dbByAsset.has(item.assetId));
  const inDbNotInBot = dbRows.filter((row) => !botByAsset.has(row.asset_id));
  const nameMismatches = dbRows.filter((row) => {
    const botName = botByAsset.get(row.asset_id);
    return botName !== undefined && botName !== row.item_name;
  });
  const unpricedRows = dbRows.filter(
    (row) => botByAsset.has(row.asset_id) && row.priced_at === null
  );

  const needsReconciliation =
    inBotNotInDb.length > 0 || inDbNotInBot.length > 0 || nameMismatches.length > 0;

  console.log('\n[reconcile-inventory] Summary');
  console.log(`  Bot tradable items (API): ${String(botItems.length)}`);
  console.log(`  prize_pool_items rows:    ${String(dbRows.length)}`);

  printSection(
    'In bot inventory but missing from prize_pool_items',
    inBotNotInDb.map((i) => `${i.name} (${i.assetId})`)
  );
  printSection(
    'In prize_pool_items but not in bot inventory (stale)',
    inDbNotInBot.map((r) => `${r.item_name} (${r.asset_id})`)
  );
  printSection(
    'Same asset_id but different item name',
    nameMismatches.map(
      (r) => `${r.asset_id}: db="${r.item_name}" bot="${botByAsset.get(r.asset_id) ?? '?'}"`
    )
  );
  printSection(
    'In both, but priced_at is null',
    unpricedRows.map((r) => `${r.item_name} (${r.asset_id})`)
  );

  if (!apply) {
    if (needsReconciliation || unpricedRows.length > 0) {
      console.log(
        '\n[reconcile-inventory] Run with --apply to fix the above.'
      );
      process.exitCode = 1;
    } else {
      console.log('\n[reconcile-inventory] OK — bot inventory and prize_pool_items are in sync.');
    }
    return;
  }

  // --- apply fixes ---

  const depositorSteamId = env.BOT_ADMINS[0] ?? '';
  let priceCacheWarmed = false;

  async function ensurePriceCache(): Promise<void> {
    if (!priceCacheWarmed) {
      await warmPriceCache();
      priceCacheWarmed = true;
    }
  }

  // Register missing rows
  if (inBotNotInDb.length > 0) {
    console.log(`\n[reconcile-inventory] Registering ${String(inBotNotInDb.length)} missing row(s)...`);
    await ensurePriceCache();
    for (const item of inBotNotInDb) {
      try {
        await upsertPrizePoolItemDirect(item.assetId, item.name, depositorSteamId);
        console.log(`  + registered "${item.name}" (${item.assetId})`);
      } catch (err) {
        console.error(`  ! failed to register ${item.assetId}:`, err);
        continue;
      }
      try {
        const price = await lookupItemPrice(item.name);
        if (price) {
          await updatePrizePoolItemPrice(item.assetId, {
            priceKeys: price.currency === 'keys' ? price.value : null,
            priceMetal: price.currency === 'metal' ? price.value : null,
            priceInMetal: price.valueInMetal
          });
          console.log(`    priced: ${String(price.value)} ${price.currency}`);
        } else {
          console.log(`    no price found`);
        }
      } catch (err) {
        console.error(`  ! failed to price ${item.assetId}:`, err);
      }
    }
  }

  // Delete stale rows
  if (inDbNotInBot.length > 0) {
    console.log(`\n[reconcile-inventory] Deleting ${String(inDbNotInBot.length)} stale row(s)...`);
    const staleIds = inDbNotInBot.map((r) => r.asset_id);
    try {
      const deleted = await deletePrizePoolItemsByAssetIds(staleIds);
      console.log(`  deleted ${String(deleted)} row(s).`);
    } catch (err) {
      console.error('  ! failed to delete stale rows:', err);
    }
  }

  // Fix name mismatches
  if (nameMismatches.length > 0) {
    console.log(`\n[reconcile-inventory] Fixing ${String(nameMismatches.length)} name mismatch(es)...`);
    for (const row of nameMismatches) {
      const newName = botByAsset.get(row.asset_id) ?? row.item_name;
      try {
        await prisma.prizePoolItem.update({
          where: { asset_id: row.asset_id },
          data: { item_name: newName }
        });
        console.log(`  ~ ${row.asset_id}: "${row.item_name}" → "${newName}"`);
      } catch (err) {
        console.error(`  ! failed to update name for ${row.asset_id}:`, err);
      }
    }
  }

  // Price unpriced rows
  if (unpricedRows.length > 0) {
    console.log(`\n[reconcile-inventory] Pricing ${String(unpricedRows.length)} unpriced row(s)...`);
    await ensurePriceCache();
    for (const row of unpricedRows) {
      try {
        const price = await lookupItemPrice(row.item_name);
        if (price) {
          await updatePrizePoolItemPrice(row.asset_id, {
            priceKeys: price.currency === 'keys' ? price.value : null,
            priceMetal: price.currency === 'metal' ? price.value : null,
            priceInMetal: price.valueInMetal
          });
          console.log(`  priced "${row.item_name}": ${String(price.value)} ${price.currency}`);
        } else {
          console.log(`  no price found for "${row.item_name}"`);
        }
      } catch (err) {
        console.error(`  ! failed to price ${row.asset_id}:`, err);
      }
    }
  }

  if (needsReconciliation || unpricedRows.length > 0) {
    console.log('\n[reconcile-inventory] Apply complete.');
    process.exitCode = 1;
  } else {
    console.log('\n[reconcile-inventory] Nothing to apply — already in sync.');
  }
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (err: unknown) {
    console.error('[reconcile-inventory] Failed:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void run();
