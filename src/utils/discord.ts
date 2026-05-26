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

export function steamProfileLink(label: string, steamId64: string): string {
  return `[${label}](https://steamcommunity.com/profiles/${steamId64})`;
}

function resolveUrl(target: WebhookTarget): string | undefined {
  return target === 'admin' ? env.DISCORD_WEBHOOK_ADMIN : env.DISCORD_WEBHOOK_DONATIONS;
}

export async function notify(target: WebhookTarget, embed: DiscordEmbed): Promise<void> {
  const url = resolveUrl(target);
  if (!url) {
    return;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '(unreadable)');
      console.error(`[discord] Webhook "${target}" returned HTTP ${String(response.status)}: ${body}`);
    }
  } catch (err) {
    console.error(`[discord] Failed to post to ${target} webhook:`, err);
  }
}

const DISCORD_FIELD_VALUE_LIMIT = 1024;
const DISCORD_EMBED_TOTAL_LIMIT = 6000;

/**
 * Splits an item list into one or more `DiscordEmbedField` objects so that every field value
 * stays within Discord's 1024-character limit. Pass the result directly to `notifySplit`.
 *
 * When the list spills across multiple fields the first field uses `labelPrefix` as its name
 * and subsequent ones use `"<labelPrefix> (cont.)"`.
 */
export function splitItemsIntoFields(items: string[], labelPrefix: string): DiscordEmbedField[] {
  if (items.length === 0) {
    return [{ name: labelPrefix, value: '—' }];
  }

  const fields: DiscordEmbedField[] = [];
  let lines: string[] = [];
  let length = 0; // tracks length of lines.join('\n')

  const flush = (): void => {
    if (lines.length === 0) return;
    fields.push({
      name: fields.length === 0 ? labelPrefix : `${labelPrefix} (cont.)`,
      value: lines.join('\n'),
    });
    lines = [];
    length = 0;
  };

  for (const item of items) {
    const line = `• ${item}`;
    const needed = lines.length > 0 ? 1 + line.length : line.length; // +1 for '\n' separator
    if (length + needed > DISCORD_FIELD_VALUE_LIMIT) {
      flush();
    }
    if (lines.length > 0) length += 1;
    lines.push(line);
    length += line.length;
  }
  flush();

  return fields;
}

/**
 * Sends `baseEmbed` (title, description, color, footer) combined with `itemFields` to the
 * given webhook target. If the combined character count would exceed Discord's 6 000-character
 * embed limit the item fields are distributed across multiple sequential posts; only the first
 * post carries the title and description.
 */
export async function notifySplit(
  target: WebhookTarget,
  baseEmbed: Omit<DiscordEmbed, 'fields'>,
  itemFields: DiscordEmbedField[]
): Promise<void> {
  if (itemFields.length === 0) {
    await notify(target, baseEmbed);
    return;
  }

  const baseSize =
    (baseEmbed.title?.length ?? 0) +
    (baseEmbed.description?.length ?? 0) +
    (baseEmbed.footer?.text.length ?? 0);

  const batches: DiscordEmbedField[][] = [];
  let currentBatch: DiscordEmbedField[] = [];
  let currentSize = baseSize; // first batch pays the overhead of the base embed

  for (const field of itemFields) {
    const fieldSize = field.name.length + field.value.length;
    if (currentBatch.length > 0 && currentSize + fieldSize > DISCORD_EMBED_TOTAL_LIMIT) {
      batches.push(currentBatch);
      currentBatch = [];
      currentSize = 0;
    }
    currentBatch.push(field);
    currentSize += fieldSize;
  }
  if (currentBatch.length > 0) batches.push(currentBatch);

  for (let i = 0; i < batches.length; i++) {
    const embed: DiscordEmbed =
      i === 0
        ? { ...baseEmbed, fields: batches[i] }
        : { color: baseEmbed.color, fields: batches[i] };
    await notify(target, embed);
  }
}
