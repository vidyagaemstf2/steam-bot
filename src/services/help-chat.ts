import type { SteamContext } from '@/steam/session.ts';

let helpChatRegistered = false;

const HELP_MESSAGE = [
  'Comandos del bot de sorteos de Steam:',
  '',
  '!ayuda / !help - Muestra este mensaje.',
  '!reclamar / !claim - Reintenta la entrega de un premio que ya ganaste. Primero agregame como amigo.',
  '!donar / !donate - Abre una ventana de donacion de 15 minutos. Mandame una oferta con solo items de TF2 para donar e inclui !donar o !donate en el mensaje de la oferta.',
  '',
  'Revision de donaciones:',
  'Las ofertas de donacion de jugadores no admins no se aceptan automaticamente. Quedan esperando que un admin las apruebe o rechace.',
  'Los admins pueden revisar donaciones pendientes en el server con sm_donaciones, sm_gdonaciones o sm_gdonations.',
  '',
  'Premios de sorteos:',
  'Los items donados y aprobados pueden aparecer en el inventario de premios y mostrar quien los dono dentro del juego.'
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
