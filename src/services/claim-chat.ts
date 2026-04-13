import SteamUser from 'steam-user';
import { hasPendingForWinner } from '@/db/pending-deliveries.ts';
import { triggerPrizeDelivery } from '@/services/delivery.ts';
import type { SteamContext } from '@/steam/session.ts';

let claimChatRegistered = false;

function isFriend(ctx: SteamContext, id64: string): boolean {
  return ctx.user.myFriends[id64] === SteamUser.EFriendRelationship.Friend;
}

/**
 * Lets winners type `!claim` in Steam chat to re-run pending delivery (same logic as on friend add).
 */
export function registerClaimChat(ctx: SteamContext): void {
  if (claimChatRegistered) {
    return;
  }
  claimChatRegistered = true;

  ctx.user.chat.on('friendMessage', (msg) => {
    if (msg.local_echo) {
      return;
    }

    const raw = (msg.message_no_bbcode ?? msg.message).trim();
    const firstToken = raw.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (firstToken !== '!claim') {
      return;
    }

    const friendSid = msg.steamid_friend;
    const id64 = friendSid.getSteamID64();

    void (async () => {
      const send = async (text: string): Promise<void> => {
        await ctx.user.chat.sendFriendMessage(friendSid, text);
      };

      if (!isFriend(ctx, id64)) {
        await send(
          'Add me as a Steam friend first, then use !claim again so I can send your giveaway prize.'
        );
        return;
      }

      const hasPending = await hasPendingForWinner(id64);
      if (!hasPending) {
        await send(
          'You have no pending giveaway prize on file. Win a giveaway on the server first — then add me and use !claim if a trade is not sent automatically.'
        );
        return;
      }

      await send(
        'Checking your pending delivery now. If your items are in my inventory, I will send a trade offer in a moment.'
      );
      triggerPrizeDelivery(ctx, id64);
    })().catch((err: unknown) => {
      console.error(`[claim-chat] Error handling !claim from ${id64}:`, err);
    });
  });
}
