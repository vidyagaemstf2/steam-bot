import { prisma } from '@/db.ts';

export type OverviewStats = {
  totalDelivered: number;
  totalDonors: number;
  prizePoolSize: number;
  totalValueMetal: number;
};

export type TopDonorRow = {
  donorSteamId: string;
  donorName: string | null;
  itemCount: number;
  totalValueMetal: number;
};

export type TopWinnerRow = {
  winnerSteamId: string;
  prizeCount: number;
};

export type PlayerDelivery = {
  assetId: string;
  itemName: string;
  createdAt: Date;
  deliveredAt: Date | null;
  expiresAt: Date | null;
};

export type PlayerStats = {
  delivered: PlayerDelivery[];
  pending: PlayerDelivery[];
  cancelled: PlayerDelivery[];
};

export async function getOverviewStats(): Promise<OverviewStats> {
  const [totalDelivered, donorGroups, prizePoolAgg] = await Promise.all([
    prisma.pendingDelivery.count({ where: { status: 'delivered' } }),
    prisma.prizePoolItem.groupBy({ by: ['donor_steam_id'], _count: { id: true } }),
    prisma.prizePoolItem.aggregate({ _count: { id: true }, _sum: { price_in_metal: true } })
  ]);

  return {
    totalDelivered,
    totalDonors: donorGroups.length,
    prizePoolSize: prizePoolAgg._count.id,
    totalValueMetal: prizePoolAgg._sum.price_in_metal ?? 0
  };
}

export async function getTopDonors(limit = 10): Promise<TopDonorRow[]> {
  const groups = await prisma.prizePoolItem.groupBy({
    by: ['donor_steam_id'],
    _count: { id: true },
    _sum: { price_in_metal: true },
    orderBy: { _count: { id: 'desc' } },
    take: limit
  });

  if (groups.length === 0) return [];

  const latestNames = await Promise.all(
    groups.map(async (g) => {
      const row = await prisma.prizePoolItem.findFirst({
        where: { donor_steam_id: g.donor_steam_id },
        select: { donor_name: true },
        orderBy: { approved_at: 'desc' }
      });
      return { steamId: g.donor_steam_id, name: row?.donor_name ?? null };
    })
  );

  const nameMap = new Map(latestNames.map((n) => [n.steamId, n.name]));

  return groups.map((g) => ({
    donorSteamId: g.donor_steam_id,
    donorName: nameMap.get(g.donor_steam_id) ?? null,
    itemCount: g._count.id,
    totalValueMetal: g._sum.price_in_metal ?? 0
  }));
}

export async function getTopWinners(limit = 10): Promise<TopWinnerRow[]> {
  const groups = await prisma.pendingDelivery.groupBy({
    by: ['winner_steam_id'],
    where: { status: 'delivered' },
    _count: { id: true },
    orderBy: { _count: { id: 'desc' } },
    take: limit
  });

  return groups.map((g) => ({
    winnerSteamId: g.winner_steam_id,
    prizeCount: g._count.id
  }));
}

export async function getPlayerStats(steamId64: string): Promise<PlayerStats> {
  const rows = await prisma.pendingDelivery.findMany({
    where: { winner_steam_id: steamId64 },
    select: {
      asset_id: true,
      item_name: true,
      status: true,
      created_at: true,
      delivered_at: true,
      expires_at: true
    },
    orderBy: { created_at: 'desc' }
  });

  const toDelivery = (r: (typeof rows)[number]): PlayerDelivery => ({
    assetId: r.asset_id,
    itemName: r.item_name,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at,
    expiresAt: r.expires_at
  });

  return {
    delivered: rows.filter((r) => r.status === 'delivered').map(toDelivery),
    pending: rows
      .filter((r) => r.status === 'pending' || r.status === 'offer_sent')
      .map(toDelivery),
    cancelled: rows.filter((r) => r.status === 'cancelled').map(toDelivery)
  };
}
