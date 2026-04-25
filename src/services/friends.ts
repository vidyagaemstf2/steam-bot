import SteamUser from 'steam-user';
import { hasPendingForWinner } from '@/db/pending-deliveries.ts';
import { shouldAllowDonationFriendRequest } from '@/services/donations.ts';
import type { SteamContext } from '@/steam/session.ts';

let friendGatingRegistered = false;

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

    void (async () => {
      const id64 = steamId.getSteamID64();

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
        user.addFriend(steamId);
        return;
      }

      console.log(`[friends] Declining friend request from ${id64}: no pending delivery or donation session`);
      user.removeFriend(steamId);
    })();
  });
}
