import { env } from '@/env.ts';

export type WebhookTarget = 'admin' | 'donations';

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title?: string;
  description?: string;
  color?: number;
  fields?: DiscordEmbedField[];
  footer?: { text: string };
}

export const Colors = {
  Green: 0x57f287,
  Red: 0xed4245,
  Yellow: 0xfee75c,
  Blue: 0x5865f2,
} as const;

function resolveUrl(target: WebhookTarget): string | undefined {
  return target === 'admin' ? env.DISCORD_WEBHOOK_ADMIN : env.DISCORD_WEBHOOK_DONATIONS;
}

export async function notify(target: WebhookTarget, embed: DiscordEmbed): Promise<void> {
  const url = resolveUrl(target);
  if (!url) {
    return;
  }

  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
  } catch (err) {
    console.error(`[discord] Failed to post to ${target} webhook:`, err);
  }
}
