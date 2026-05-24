import { prisma } from '@/db.ts';
import { env } from '@/env.ts';
import type { PendingDelivery } from '../../generated/prisma/client.ts';

const RESERVED_STATUSES = ['pending', 'offer_sent'] as const;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function defaultExpiry(): Date {
  return new Date(Date.now() + env.MANUAL_DELIVERY_EXPIRY_DAYS * MS_PER_DAY);
}

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

export async function hasActiveDeliveryForWinner(winnerSteamId: string): Promise<boolean> {
  const n = await prisma.pendingDelivery.count({
    where: { winner_steam_id: winnerSteamId, status: { in: [...RESERVED_STATUSES] } }
  });
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
  itemName: string,
  expiresAt?: Date
): Promise<PendingDelivery> {
  const normalizedAssetId = assetId.trim();

  const existing = await findActiveDeliveryByAssetId(normalizedAssetId);
  if (existing) {
    if (existing.winner_steam_id === winnerSteamId) {
      return existing;
    }
    throw new Error(
      `Asset ${normalizedAssetId} (${itemName}) is already actively reserved for winner ${existing.winner_steam_id}`
    );
  }

  const effectiveExpiry = expiresAt ?? defaultExpiry();

  try {
    return await prisma.pendingDelivery.create({
      data: {
        winner_steam_id: winnerSteamId,
        asset_id: normalizedAssetId,
        active_reservation_key: activeReservationKey(winnerSteamId, normalizedAssetId),
        item_name: itemName,
        status: 'pending',
        expires_at: effectiveExpiry
      }
    });
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const race = await findActiveDeliveryByAssetId(normalizedAssetId);
      if (race) {
        if (race.winner_steam_id === winnerSteamId) {
          return race;
        }
        throw new Error(
          `Asset ${normalizedAssetId} (${itemName}) is already actively reserved for winner ${race.winner_steam_id}`
        );
      }
    }
    throw err;
  }
}

export async function cancelDeliveriesByTradeOfferId(tradeOfferId: string): Promise<PendingDelivery[]> {
  const rows = await prisma.pendingDelivery.findMany({
    where: {
      trade_offer_id: tradeOfferId,
      status: { in: [...RESERVED_STATUSES] }
    }
  });
  if (rows.length === 0) return [];
  await prisma.pendingDelivery.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { status: 'cancelled', active_reservation_key: null }
  });
  return rows;
}

export async function cancelDeliveriesByAssetIds(assetIds: string[]): Promise<PendingDelivery[]> {
  if (assetIds.length === 0) return [];
  const active = await prisma.pendingDelivery.findMany({
    where: {
      asset_id: { in: assetIds },
      status: { in: [...RESERVED_STATUSES] }
    }
  });
  if (active.length === 0) return [];
  await prisma.pendingDelivery.updateMany({
    where: { id: { in: active.map((r) => r.id) } },
    data: { status: 'cancelled', active_reservation_key: null }
  });
  return active;
}

export async function findActiveDeliveryByAssetId(assetId: string): Promise<PendingDelivery | null> {
  return prisma.pendingDelivery.findFirst({
    where: {
      asset_id: assetId.trim(),
      status: { in: [...RESERVED_STATUSES] }
    },
    orderBy: { id: 'asc' }
  });
}

export async function listActiveDeliveries(): Promise<PendingDelivery[]> {
  return prisma.pendingDelivery.findMany({
    where: { status: { in: [...RESERVED_STATUSES] } },
    orderBy: { created_at: 'desc' }
  });
}

export async function cancelExpiredDeliveries(): Promise<PendingDelivery[]> {
  const now = new Date();
  const expired = await prisma.pendingDelivery.findMany({
    where: {
      status: 'pending',
      expires_at: { not: null, lt: now }
    }
  });
  if (expired.length === 0) {
    return [];
  }
  await prisma.pendingDelivery.updateMany({
    where: { id: { in: expired.map((r) => r.id) } },
    data: { status: 'cancelled', active_reservation_key: null }
  });
  return expired;
}

export async function findStaleOfferSentDeliveries(): Promise<PendingDelivery[]> {
  const now = new Date();
  return prisma.pendingDelivery.findMany({
    where: {
      status: 'offer_sent',
      expires_at: { not: null, lt: now }
    }
  });
}

export async function cancelDeliveriesByIds(ids: number[]): Promise<void> {
  if (ids.length === 0) return;
  await prisma.pendingDelivery.updateMany({
    where: { id: { in: ids } },
    data: { status: 'cancelled', active_reservation_key: null, trade_offer_id: null }
  });
}

export type WithdrawCleanupResult = {
  cancelledDeliveries: PendingDelivery[];
  deletedPoolCount: number;
};

/**
 * Atomically cancels any active deliveries and removes prize pool entries for the
 * given asset IDs. Both operations are wrapped in a single transaction so a partial
 * failure cannot leave the database in an inconsistent state.
 */
export async function cleanupWithdrawnItems(assetIds: string[]): Promise<WithdrawCleanupResult> {
  if (assetIds.length === 0) return { cancelledDeliveries: [], deletedPoolCount: 0 };

  const active = await prisma.pendingDelivery.findMany({
    where: {
      asset_id: { in: assetIds },
      status: { in: [...RESERVED_STATUSES] }
    }
  });

  const deletedPoolCount = await prisma.$transaction(async (tx) => {
    if (active.length > 0) {
      await tx.pendingDelivery.updateMany({
        where: { id: { in: active.map((r) => r.id) } },
        data: { status: 'cancelled', active_reservation_key: null }
      });
    }

    const deleted = await tx.prizePoolItem.deleteMany({
      where: { asset_id: { in: assetIds } }
    });

    return deleted.count;
  });

  return { cancelledDeliveries: active, deletedPoolCount };
}
