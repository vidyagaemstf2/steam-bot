import type { SteamContext } from '@/steam/session.ts';

export async function resolvePersonaName(ctx: SteamContext, steamId64: string): Promise<string> {
  const users = ctx.user.users as Record<string, Record<string, unknown> | undefined>;
  const tryCache = (): string | null => {
    const persona = users[steamId64];
    if (!persona) return null;
    for (const key of ['player_name', 'persona_name', 'personaName', 'name']) {
      const v = persona[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return null;
  };

  const cached = tryCache();
  if (cached) return cached;

  await new Promise<void>((resolve) => {
    ctx.user.getPersonas([steamId64], () => resolve());
  });

  return tryCache() ?? steamId64;
}
