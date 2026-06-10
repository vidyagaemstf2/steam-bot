import { prisma } from '@/db.ts';
import type { DonationOffer, DonationOfferItem, PrizePoolItem } from '../../generated/prisma/client.ts';

export type PriceInput = {
  priceKeys?: number | null;
  priceMetal?: number | null;
  priceInMetal: number;
};

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

const DONATION_APPROVAL_TRANSACTION_TIMEOUT_MS = 30_000;

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
    if (existing.status === 'accepted_failed') {
      return prisma.donationOffer.update({
        where: { trade_offer_id: input.tradeOfferId },
        data: {
          status: 'pending_review',
          reviewed_by_id: null,
          reviewed_by_name: null,
          review_note: null,
          reviewed_at: null,
          accepted_at: null
        },
        include: { items: true }
      });
    }
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

export type PendingDonationOfferWithMeta = PendingDonationOffer & {
  acceptFailed: boolean;
  failureReason: string | null;
};

export async function listPendingDonationOffers(): Promise<PendingDonationOfferWithMeta[]> {
  const rows = await prisma.donationOffer.findMany({
    where: { status: { in: ['pending_review', 'accepted_failed'] } },
    include: { items: true },
    orderBy: { created_at: 'asc' }
  });
  return rows.map((row) => ({
    ...row,
    acceptFailed: row.status === 'accepted_failed',
    failureReason: row.status === 'accepted_failed' ? (row.review_note ?? null) : null
  }));
}

export async function findPendingDonationOffer(
  tradeOfferId: string
): Promise<PendingDonationOffer | null> {
  return prisma.donationOffer.findFirst({
    where: { trade_offer_id: tradeOfferId, status: { in: ['pending_review', 'accepted_failed'] } },
    include: { items: true }
  });
}

export async function requeueFailedDonationOffer(tradeOfferId: string): Promise<boolean> {
  const result = await prisma.donationOffer.updateMany({
    where: { trade_offer_id: tradeOfferId, status: 'accepted_failed' },
    data: {
      status: 'pending_review',
      reviewed_by_id: null,
      reviewed_by_name: null,
      review_note: null,
      reviewed_at: null,
      accepted_at: null
    }
  });
  return result.count > 0;
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
  await prisma.$transaction(
    async (tx) => {
      await tx.donationOffer.update({
        where: { trade_offer_id: offer.trade_offer_id },
        data: {
          status: 'approved',
          reviewed_by_id: reviewer.reviewerSteamId,
          reviewed_by_name: reviewer.reviewerName,
          review_note: reviewer.note,
          reviewed_at: now,
          accepted_at: now
        }
      });

      for (const item of prizeItems) {
        await tx.prizePoolItem.upsert({
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
            approved_at: now,
            price_keys: null,
            price_metal: null,
            price_in_metal: null,
            priced_at: null
          }
        });
      }
    },
    { timeout: DONATION_APPROVAL_TRANSACTION_TIMEOUT_MS }
  );
}

export async function deletePendingDonationOffer(tradeOfferId: string): Promise<boolean> {
  const result = await prisma.donationOffer.deleteMany({
    where: { trade_offer_id: tradeOfferId, status: 'pending_review' }
  });
  return result.count > 0;
}

export async function listPrizePoolItemsByAssetIds(assetIds: string[]): Promise<PrizePoolItem[]> {
  if (assetIds.length === 0) {
    return [];
  }
  return prisma.prizePoolItem.findMany({
    where: { asset_id: { in: [...new Set(assetIds)] } }
  });
}

export async function deletePrizePoolItemsByAssetIds(assetIds: string[]): Promise<number> {
  if (assetIds.length === 0) return 0;
  const result = await prisma.prizePoolItem.deleteMany({
    where: { asset_id: { in: assetIds } }
  });
  return result.count;
}

export async function updatePrizePoolItemPrice(assetId: string, price: PriceInput): Promise<void> {
  await prisma.prizePoolItem.update({
    where: { asset_id: assetId },
    data: {
      price_keys: price.priceKeys ?? null,
      price_metal: price.priceMetal ?? null,
      price_in_metal: price.priceInMetal,
      priced_at: new Date()
    }
  });
}

export async function upsertPrizePoolItemDirect(
  assetId: string,
  itemName: string,
  depositorSteamId: string
): Promise<void> {
  const now = new Date();
  await prisma.prizePoolItem.upsert({
    where: { asset_id: assetId },
    update: { item_name: itemName, donor_steam_id: depositorSteamId, approved_at: now },
    create: {
      asset_id: assetId,
      item_name: itemName,
      donor_steam_id: depositorSteamId,
      donation_offer_id: null,
      approved_at: now,
      price_keys: null,
      price_metal: null,
      price_in_metal: null,
      priced_at: null
    }
  });
}
