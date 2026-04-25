import SteamUser from 'steam-user';
import { hasPendingForWinner } from '@/db/pending-deliveries.ts';
import { requestPrizeDelivery } from '@/services/delivery.ts';
import type { SteamContext } from '@/steam/session.ts';

let claimChatRegistered = false;

function isFriend(ctx: SteamContext, id64: string): boolean {
  return ctx.user.myFriends[id64] === SteamUser.EFriendRelationship.Friend;
}

/**
 * Lets winners retry pending delivery from Steam chat (same logic as on friend add).
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
    if (firstToken !== '!claim' && firstToken !== '!reclamar') {
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
          'Agregame como amigo en Steam primero. Despues usa !reclamar o !claim otra vez para que pueda mandarte tu premio.'
        );
        return;
      }

      const hasPending = await hasPendingForWinner(id64);
      if (!hasPending) {
        await send(
          'No tenes ningun premio pendiente registrado. Primero gana un sorteo en el server; despues agregame y usa !reclamar si la oferta no llega automaticamente.'
        );
        return;
      }

      await send(
        'Estoy revisando tu entrega pendiente. Si Steam me deja mandar la oferta, te aviso en un momento.'
      );
      const result = await requestPrizeDelivery(ctx, id64);
      await send(result.message);
    })().catch((err: unknown) => {
      console.error(`[claim-chat] Error handling !claim from ${id64}:`, err);
    });
  });
}
