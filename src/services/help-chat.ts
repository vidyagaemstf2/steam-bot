import type { SteamContext } from '@/steam/session.ts';

let helpChatRegistered = false;

const HELP_MESSAGE = [
  'Comandos del bot de sorteos de Steam:',
  '',
  '!ayuda / !help - Muestra este mensaje.',
  '!reclamar / !claim - Reintenta la entrega de un premio que ya ganaste. Primero agregame como amigo.',
  '',
  'Para donar items a los sorteos:',
  'Usa el link de trade del bot y manda una oferta con solo items de TF2. Incluí !donar o !donate en el mensaje de la oferta.'
].join('\n');

export function registerHelpChat(ctx: SteamContext): void {
  if (helpChatRegistered) {
    return;
  }
  helpChatRegistered = true;

  ctx.user.chat.on('friendMessage', (msg) => {
    if (msg.local_echo) {
      return;
    }

    const raw = (msg.message_no_bbcode ?? msg.message).trim();
    const firstToken = raw.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (firstToken !== '!help' && firstToken !== '!ayuda') {
      return;
    }

    const friendSid = msg.steamid_friend;
    void ctx.user.chat.sendFriendMessage(friendSid, HELP_MESSAGE).catch((err: unknown) => {
      console.error('[help-chat] Error sending !help response:', err);
    });
  });
}
