import { prisma } from '@/db.ts';
import type {
  DonationOffer,
  DonationOfferItem,
  DonationSession,
  PrizePoolItem
} from '../../generated/prisma/client.ts';

export type DonationSessionSource = 'game_command' | 'steam_dm';

export type DonationItemInput = {
  appId: number;
  contextId: string;
  assetId: string;
  classId?: string | null;
  instanceId?: string | null;
  name: string;
  iconUrl?: string | null;
};

export type DonationReviewerInput = {
  reviewerSteamId?: string | null;
  reviewerName?: string | null;
  note?: string | null;
};

export type PendingDonationOffer = DonationOffer & {
  items: DonationOfferItem[];
};

export type DonationSessionResult = {
  session: DonationSession;
  created: boolean;
};

const DONATION_SESSION_MS = 15 * 60 * 1000;

function expiryDate(now = new Date()): Date {
  return new Date(now.getTime() + DONATION_SESSION_MS);
}

function activeDonationSessionKey(donorSteamId: string): string {
  return donorSteamId;
}

function isUniqueConstraintError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') {
    return false;
  }
  return (err as { code?: unknown }).code === 'P2002';
}

export async function expireOldDonationSessions(now = new Date()): Promise<void> {
  await prisma.donationSession.updateMany({
    where: {
      status: 'active',
      expires_at: { lt: now }
    },
    data: { status: 'expired' }
  });
  await prisma.donationSession.updateMany({
    where: {
      status: { not: 'active' },
      active_session_key: { not: null }
    },
    data: { active_session_key: null }
  });
}

export async function createDonationSession(
  donorSteamId: string,
  donorName: string | null,
  source: DonationSessionSource
): Promise<DonationSessionResult> {
  const now = new Date();
  await expireOldDonationSessions(now);
  const existing = await findActiveDonationSession(donorSteamId);
  if (existing) {
    return { session: existing, created: false };
  }

  try {
    const session = await prisma.donationSession.create({
      data: {
        donor_steam_id: donorSteamId,
        active_session_key: activeDonationSessionKey(donorSteamId),
        donor_name: donorName,
        source,
        status: 'active',
        expires_at: expiryDate(now)
      }
    });
    return { session, created: true };
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const current = await findActiveDonationSession(donorSteamId);
      if (current) {
        return { session: current, created: false };
      }
    }
    throw err;
  }
}

export async function findActiveDonationSession(
  donorSteamId: string
): Promise<DonationSession | null> {
  const now = new Date();
  await expireOldDonationSessions(now);
  return prisma.donationSession.findFirst({
    where: {
      donor_steam_id: donorSteamId,
      status: 'active',
      expires_at: { gte: now }
    },
    orderBy: { expires_at: 'desc' }
  });
}

export async function hasActiveDonationSession(donorSteamId: string): Promise<boolean> {
  const session = await findActiveDonationSession(donorSteamId);
  return session !== null;
}

export async function markDonationSessionsUsed(donorSteamId: string): Promise<void> {
  await prisma.donationSession.updateMany({
    where: {
      donor_steam_id: donorSteamId,
      status: 'active',
      expires_at: { gte: new Date() }
    },
    data: { status: 'used', active_session_key: null }
  });
}

export async function recordDonationOffer(input: {
  tradeOfferId: string;
  donorSteamId: string;
  donorName: string | null;
  message: string | null;
  items: DonationItemInput[];
}): Promise<PendingDonationOffer> {
  const existing = await prisma.donationOffer.findUnique({
    where: { trade_offer_id: input.tradeOfferId },
    include: { items: true }
  });
  if (existing) {
    return existing;
  }

  return prisma.donationOffer.create({
    data: {
      trade_offer_id: input.tradeOfferId,
      donor_steam_id: input.donorSteamId,
      donor_name: input.donorName,
      message: input.message,
      status: 'pending_review',
      items: {
        create: input.items.map((item) => ({
          app_id: item.appId,
          context_id: item.contextId,
          asset_id: item.assetId,
          class_id: item.classId,
          instance_id: item.instanceId,
          name: item.name,
          icon_url: item.iconUrl
        }))
      }
    },
    include: { items: true }
  });
}

export async function listPendingDonationOffers(): Promise<PendingDonationOffer[]> {
  return prisma.donationOffer.findMany({
    where: { status: 'pending_review' },
    include: { items: true },
    orderBy: { created_at: 'asc' }
  });
}

export async function findPendingDonationOffer(
  tradeOfferId: string
): Promise<PendingDonationOffer | null> {
  return prisma.donationOffer.findFirst({
    where: { trade_offer_id: tradeOfferId, status: 'pending_review' },
    include: { items: true }
  });
}

export async function markDonationAcceptedFailed(
  tradeOfferId: string,
  reviewer: DonationReviewerInput,
  reason: string
): Promise<void> {
  await prisma.donationOffer.update({
    where: { trade_offer_id: tradeOfferId },
    data: {
      status: 'accepted_failed',
      reviewed_by_id: reviewer.reviewerSteamId,
      reviewed_by_name: reviewer.reviewerName,
      review_note: reason,
      reviewed_at: new Date()
    }
  });
}

export async function markDonationRejected(
  tradeOfferId: string,
  reviewer: DonationReviewerInput
): Promise<void> {
  await prisma.donationOffer.update({
    where: { trade_offer_id: tradeOfferId },
    data: {
      status: 'rejected',
      reviewed_by_id: reviewer.reviewerSteamId,
      reviewed_by_name: reviewer.reviewerName,
      review_note: reviewer.note,
      reviewed_at: new Date()
    }
  });
}

export async function markDonationRejectedByPolicy(
  tradeOfferId: string,
  reason: string
): Promise<void> {
  await prisma.donationOffer.updateMany({
    where: { trade_offer_id: tradeOfferId, status: 'pending_review' },
    data: {
      status: 'rejected',
      review_note: reason,
      reviewed_at: new Date()
    }
  });
}

export async function markDonationApproved(
  offer: PendingDonationOffer,
  reviewer: DonationReviewerInput,
  prizeItems: DonationItemInput[]
): Promise<void> {
  const now = new Date();
  await prisma.$transaction([
    prisma.donationOffer.update({
      where: { trade_offer_id: offer.trade_offer_id },
      data: {
        status: 'approved',
        reviewed_by_id: reviewer.reviewerSteamId,
        reviewed_by_name: reviewer.reviewerName,
        review_note: reviewer.note,
        reviewed_at: now,
        accepted_at: now
      }
    }),
    ...prizeItems.map((item) =>
      prisma.prizePoolItem.upsert({
        where: { asset_id: item.assetId },
        update: {
          item_name: item.name,
          donor_steam_id: offer.donor_steam_id,
          donor_name: offer.donor_name,
          donation_offer_id: offer.id,
          approved_at: now
        },
        create: {
          asset_id: item.assetId,
          item_name: item.name,
          donor_steam_id: offer.donor_steam_id,
          donor_name: offer.donor_name,
          donation_offer_id: offer.id,
          approved_at: now
        }
      })
    )
  ]);
}

export async function listPrizePoolItemsByAssetIds(assetIds: string[]): Promise<PrizePoolItem[]> {
  if (assetIds.length === 0) {
    return [];
  }
  return prisma.prizePoolItem.findMany({
    where: { asset_id: { in: [...new Set(assetIds)] } }
  });
}
