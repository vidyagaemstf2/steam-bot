import { prisma } from '@/db.ts';
import type { PendingDelivery } from '../../generated/prisma/client.ts';

const RESERVED_STATUSES = ['pending', 'offer_sent'] as const;

/**
 * Asset IDs currently tied to an undelivered delivery (inventory must not list these).
 */
export async function listReservedAssetIds(): Promise<string[]> {
  const rows = await prisma.pendingDelivery.findMany({
    where: { status: { in: [...RESERVED_STATUSES] } },
    select: { asset_id: true }
  });
  return [...new Set(rows.map((r) => r.asset_id))];
}

export async function countPendingForWinner(winnerSteamId: string): Promise<number> {
  return prisma.pendingDelivery.count({
    where: { winner_steam_id: winnerSteamId, status: 'pending' }
  });
}

export async function hasPendingForWinner(winnerSteamId: string): Promise<boolean> {
  const n = await countPendingForWinner(winnerSteamId);
  return n > 0;
}

export async function listPendingRowsForWinner(winnerSteamId: string): Promise<PendingDelivery[]> {
  return prisma.pendingDelivery.findMany({
    where: { winner_steam_id: winnerSteamId, status: 'pending' }
  });
}

export async function listOfferSentRows(): Promise<PendingDelivery[]> {
  return prisma.pendingDelivery.findMany({
    where: { status: 'offer_sent' }
  });
}

export async function listOfferSentRowsForWinner(
  winnerSteamId: string
): Promise<PendingDelivery[]> {
  return prisma.pendingDelivery.findMany({
    where: { winner_steam_id: winnerSteamId, status: 'offer_sent' }
  });
}

export async function markRowsOfferSent(ids: number[], tradeOfferId: string): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await prisma.pendingDelivery.updateMany({
    where: { id: { in: ids } },
    data: { status: 'offer_sent', trade_offer_id: tradeOfferId }
  });
}

export async function markDeliveredByTradeOfferId(tradeOfferId: string): Promise<void> {
  await prisma.pendingDelivery.updateMany({
    where: { trade_offer_id: tradeOfferId, status: 'offer_sent' },
    data: { status: 'delivered', delivered_at: new Date() }
  });
}

export async function resetOfferSentToPending(ids: number[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await prisma.pendingDelivery.updateMany({
    where: { id: { in: ids }, status: 'offer_sent' },
    data: { status: 'pending', trade_offer_id: null, delivered_at: null }
  });
}

export async function resetOfferSentToPendingByTradeOfferId(tradeOfferId: string): Promise<void> {
  await prisma.pendingDelivery.updateMany({
    where: { trade_offer_id: tradeOfferId, status: 'offer_sent' },
    data: { status: 'pending', trade_offer_id: null, delivered_at: null }
  });
}

export async function findRowsByTradeOfferId(tradeOfferId: string): Promise<PendingDelivery[]> {
  return prisma.pendingDelivery.findMany({
    where: { trade_offer_id: tradeOfferId }
  });
}
