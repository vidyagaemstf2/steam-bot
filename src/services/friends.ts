import SteamUser from 'steam-user';
import { hasPendingForWinner } from '@/db/pending-deliveries.ts';
import { shouldAllowDonationFriendRequest } from '@/services/donations.ts';
import type { SteamContext } from '@/steam/session.ts';

let friendGatingRegistered = false;

async function applyFriendRequestGating(user: SteamUser, id64: string): Promise<void> {
  let allow = false;
  let reason = '';
  try {
    allow = await hasPendingForWinner(id64);
    reason = allow ? 'pending delivery exists' : '';
  } catch (err) {
    console.error(`[friends] DB error checking pending deliveries for ${id64}:`, err);
    allow = false;
  }

  if (!allow) {
    try {
      allow = await shouldAllowDonationFriendRequest(id64);
      reason = allow ? 'active donation session exists' : '';
    } catch (err) {
      console.error(`[friends] DB error checking donation session for ${id64}:`, err);
      allow = false;
    }
  }

  if (allow) {
    console.log(`[friends] Accepting friend request from ${id64} (${reason})`);
    user.addFriend(id64);
    return;
  }

  console.log(
    `[friends] Declining friend request from ${id64}: no pending delivery or donation session`
  );
  user.removeFriend(id64);
}

function pollPendingIncomingFriendRequestsFromList(user: SteamUser): void {
  const pending = Object.entries(user.myFriends).filter(
    ([, rel]) => rel === SteamUser.EFriendRelationship.RequestRecipient
  );

  if (pending.length === 0) {
    return;
  }

  console.log(
    `[friends] Found ${String(pending.length)} pending incoming friend request(s) in list (e.g. while offline); processing...`
  );

  for (const [id64] of pending) {
    void applyFriendRequestGating(user, id64).catch((err: unknown) => {
      console.error(`[friends] Failed to process pending friend request for ${id64}:`, err);
    });
  }
}

export function registerFriendGating(ctx: SteamContext): void {
  if (friendGatingRegistered) {
    return;
  }
  friendGatingRegistered = true;

  const { user } = ctx;

  user.on('friendRelationship', (steamId, relationship) => {
    if (relationship !== SteamUser.EFriendRelationship.RequestRecipient) {
      return;
    }

    const id64 = steamId.getSteamID64();
    void applyFriendRequestGating(user, id64).catch((err: unknown) => {
      console.error(`[friends] Failed to process friendRelationship for ${id64}:`, err);
    });
  });

  user.on('friendsList', () => {
    pollPendingIncomingFriendRequestsFromList(user);
  });

  pollPendingIncomingFriendRequestsFromList(user);
}
