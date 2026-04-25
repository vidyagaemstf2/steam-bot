import { prisma } from '@/db.ts';
import type { PendingDelivery } from '../../generated/prisma/client.ts';

const RESERVED_STATUSES = ['pending', 'offer_sent'] as const;

export type DeliveryFailureInput = {
  code: string;
  message: string;
};

function activeReservationKey(winnerSteamId: string, assetId: string): string {
  return `${winnerSteamId}:${assetId}`;
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  return (err as { code?: unknown }).code === 'P2002';
}

async function findActiveDeliveryForAsset(
  winnerSteamId: string,
  assetId: string
): Promise<PendingDelivery | null> {
  return prisma.pendingDelivery.findFirst({
    where: {
      winner_steam_id: winnerSteamId,
      asset_id: assetId,
      status: { in: [...RESERVED_STATUSES] }
    },
    orderBy: { id: 'asc' }
  });
}

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
  const rows = await prisma.pendingDelivery.findMany({
    where: { id: { in: ids } },
    select: { id: true, winner_steam_id: true, asset_id: true }
  });
  await prisma.$transaction(
    rows.map((row) =>
      prisma.pendingDelivery.update({
        where: { id: row.id },
        data: {
          status: 'offer_sent',
          trade_offer_id: tradeOfferId,
          last_attempt_at: new Date(),
          last_failure_code: null,
          last_failure_message: null,
          active_reservation_key: activeReservationKey(row.winner_steam_id, row.asset_id)
        }
      })
    )
  );
}

export async function markDeliveredByTradeOfferId(tradeOfferId: string): Promise<void> {
  await prisma.pendingDelivery.updateMany({
    where: { trade_offer_id: tradeOfferId, status: 'offer_sent' },
    data: {
      status: 'delivered',
      delivered_at: new Date(),
      active_reservation_key: null,
      last_failure_code: null,
      last_failure_message: null
    }
  });
}

export async function markRowsDeliveryAttemptFailed(
  ids: number[],
  failure: DeliveryFailureInput
): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  await prisma.pendingDelivery.updateMany({
    where: { id: { in: ids }, status: 'pending' },
    data: {
      last_attempt_at: new Date(),
      last_failure_code: truncate(failure.code, 64),
      last_failure_message: truncate(failure.message, 512)
    }
  });
}

export async function resetOfferSentToPending(ids: number[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }
  const rows = await prisma.pendingDelivery.findMany({
    where: { id: { in: ids }, status: 'offer_sent' },
    select: { id: true, winner_steam_id: true, asset_id: true }
  });
  await prisma.$transaction(
    rows.map((row) =>
      prisma.pendingDelivery.update({
        where: { id: row.id },
        data: {
          status: 'pending',
          trade_offer_id: null,
          delivered_at: null,
          last_failure_code: null,
          last_failure_message: null,
          active_reservation_key: activeReservationKey(row.winner_steam_id, row.asset_id)
        }
      })
    )
  );
}

export async function resetOfferSentToPendingByTradeOfferId(tradeOfferId: string): Promise<void> {
  const rows = await prisma.pendingDelivery.findMany({
    where: { trade_offer_id: tradeOfferId, status: 'offer_sent' },
    select: { id: true, winner_steam_id: true, asset_id: true }
  });
  await prisma.$transaction(
    rows.map((row) =>
      prisma.pendingDelivery.update({
        where: { id: row.id },
        data: {
          status: 'pending',
          trade_offer_id: null,
          delivered_at: null,
          last_failure_code: null,
          last_failure_message: null,
          active_reservation_key: activeReservationKey(row.winner_steam_id, row.asset_id)
        }
      })
    )
  );
}

export async function findRowsByTradeOfferId(tradeOfferId: string): Promise<PendingDelivery[]> {
  return prisma.pendingDelivery.findMany({
    where: { trade_offer_id: tradeOfferId }
  });
}

export async function createPendingDelivery(
  winnerSteamId: string,
  assetId: string,
  itemName: string
): Promise<PendingDelivery> {
  const normalizedAssetId = assetId.trim();
  const existing = await findActiveDeliveryForAsset(winnerSteamId, normalizedAssetId);
  if (existing) {
    return existing;
  }

  try {
    return await prisma.pendingDelivery.create({
      data: {
        winner_steam_id: winnerSteamId,
        asset_id: normalizedAssetId,
        active_reservation_key: activeReservationKey(winnerSteamId, normalizedAssetId),
        item_name: itemName,
        status: 'pending'
      }
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const winnerDelivery = await findActiveDeliveryForAsset(winnerSteamId, normalizedAssetId);
      if (winnerDelivery) {
        return winnerDelivery;
      }
    }
    throw err;
  }
}
