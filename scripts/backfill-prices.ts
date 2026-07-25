/**
 * One-shot backfill: fetches backpack.tf prices for all prize_pool_items rows
 * that have not been priced yet (priced_at IS NULL).
 *
 * Run: bun scripts/backfill-prices.ts
 *
 * Safe to run multiple times — already-priced rows are skipped.
 */
import { prisma } from '@/db.ts';
import { updatePrizePoolItemPrice } from '@/db/donations.ts';
import { lookupItemPrice, warmPriceCache } from '@/services/backpack-prices.ts';

async function main(): Promise<void> {
  await prisma.$connect();
  console.log('[backfill-prices] Connected to database.');

  const rows = await prisma.prizePoolItem.findMany({
    where: { priced_at: null },
    select: { asset_id: true, item_name: true }
  });

  if (rows.length === 0) {
    console.log('[backfill-prices] No unpriced rows found. Nothing to do.');
    return;
  }

  console.log(
    `[backfill-prices] Found ${String(rows.length)} unpriced row(s). Loading price cache.`
  );
  await warmPriceCache();

  let priced = 0;
  let skipped = 0;

  for (const row of rows) {
    const price = await lookupItemPrice(row.item_name);
    if (!price) {
      console.log(`[backfill-prices] No price found for "${row.item_name}" (${row.asset_id})`);
      skipped++;
      continue;
    }

    await updatePrizePoolItemPrice(row.asset_id, {
      priceKeys: price.currency === 'keys' ? price.value : null,
      priceMetal: price.currency === 'metal' ? price.value : null,
      priceInMetal: price.valueInMetal
    });

    console.log(
      `[backfill-prices] Priced "${row.item_name}": ${String(price.value)} ${price.currency} (${String(price.valueInMetal)} ref)`
    );
    priced++;
  }

  console.log(
    `[backfill-prices] Done. Priced: ${String(priced)}, no price found: ${String(skipped)}.`
  );
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (err: unknown) {
    console.error('[backfill-prices] Failed:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void run();
