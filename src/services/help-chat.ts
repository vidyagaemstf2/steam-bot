import type { SteamContext } from '@/steam/session.ts';

let helpChatRegistered = false;

const HELP_MESSAGE = [
  'Steam giveaway bot commands:',
  '',
  '!help - Show this message.',
  '!claim - Retry delivery for a giveaway prize you already won. Add me as a friend first.',
  '!donate - Open a 15 minute donation window. Send a trade offer containing only donated TF2 items and include !donate in the trade message.',
  '',
  'Donation review:',
  'Non-admin donation offers are not accepted automatically. They wait for server admins to approve or reject them.',
  'Admins can review pending donations in-game with sm_gdonations.',
  '',
  'Giveaway prizes:',
  'Approved donated items can appear in the giveaway prize inventory and may show donor attribution in-game.'
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
    if (firstToken !== '!help') {
      return;
    }

    const friendSid = msg.steamid_friend;
    void ctx.user.chat.sendFriendMessage(friendSid, HELP_MESSAGE).catch((err: unknown) => {
      console.error('[help-chat] Error sending !help response:', err);
    });
  });
}
