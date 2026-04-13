/**
 * Integration smoke test for `src/db/pending-deliveries.ts`.
 * Run: `pnpm db:smoke` (uses `.env` — needs `DATABASE_URL` and all vars required by `src/env.ts`).
 */
import { prisma } from '@/db.ts';
import {
  countPendingForWinner,
  findRowsByTradeOfferId,
  hasPendingForWinner,
  listOfferSentRows,
  listPendingRowsForWinner,
  listReservedAssetIds,
  markDeliveredByTradeOfferId,
  markRowsOfferSent,
  resetOfferSentToPending,
  resetOfferSentToPendingByTradeOfferId
} from '@/db/pending-deliveries.ts';

const TEST_WINNER = '76561198000000001';
const runId = Date.now();

async function main(): Promise<void> {
  await prisma.$connect();
  console.log('[db-smoke] Connected.');

  await listReservedAssetIds();
  await listOfferSentRows();
  await countPendingForWinner(TEST_WINNER);

  const assetId = `smoke_asset_${String(runId)}`;
  const row = await prisma.pendingDelivery.create({
    data: {
      winner_steam_id: TEST_WINNER,
      asset_id: assetId,
      item_name: 'db-smoke test item',
      status: 'pending'
    }
  });
  const id = row.id;
  console.log('[db-smoke] Created test row id=', id);

  if (!(await hasPendingForWinner(TEST_WINNER))) {
    throw new Error('hasPendingForWinner expected true');
  }
  const pendingRows = await listPendingRowsForWinner(TEST_WINNER);
  if (!pendingRows.some((r) => r.id === id)) {
    throw new Error('listPendingRowsForWinner missing new row');
  }
  const reserved = await listReservedAssetIds();
  if (!reserved.includes(assetId)) {
    throw new Error('listReservedAssetIds missing asset');
  }

  const tid = `smoke_tid_${String(runId)}`;
  await markRowsOfferSent([id], tid);
  const offerSent = await listOfferSentRows();
  if (!offerSent.some((r) => r.id === id && r.trade_offer_id === tid)) {
    throw new Error('markRowsOfferSent / listOfferSentRows');
  }
  const byTid = await findRowsByTradeOfferId(tid);
  if (byTid.length !== 1 || byTid[0]?.id !== id) {
    throw new Error('findRowsByTradeOfferId');
  }

  await resetOfferSentToPending([id]);
  const afterReset = await prisma.pendingDelivery.findUnique({ where: { id } });
  if (afterReset?.status !== 'pending' || afterReset.trade_offer_id !== null) {
    throw new Error('resetOfferSentToPending');
  }

  const tid2 = `smoke_tid2_${String(runId)}`;
  await markRowsOfferSent([id], tid2);
  await resetOfferSentToPendingByTradeOfferId(tid2);
  const afterReset2 = await prisma.pendingDelivery.findUnique({ where: { id } });
  if (afterReset2?.status !== 'pending') {
    throw new Error('resetOfferSentToPendingByTradeOfferId');
  }

  const tid3 = `smoke_tid3_${String(runId)}`;
  await markRowsOfferSent([id], tid3);
  await markDeliveredByTradeOfferId(tid3);
  const delivered = await prisma.pendingDelivery.findUnique({ where: { id } });
  if (delivered?.status !== 'delivered' || !delivered.delivered_at) {
    throw new Error('markDeliveredByTradeOfferId');
  }

  await prisma.pendingDelivery.delete({ where: { id } });
  console.log('[db-smoke] Deleted test row. All checks passed.');
}

async function run(): Promise<void> {
  try {
    await main();
  } catch (err: unknown) {
    console.error('[db-smoke] Failed:', err);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void run();
