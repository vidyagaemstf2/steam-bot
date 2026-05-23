import type { SteamContext } from '@/steam/session.ts';

export function resolvePersonaName(ctx: SteamContext, steamId64: string): string {
  const persona = (ctx.user.users as Record<string, unknown>)[steamId64] as
    | Record<string, unknown>
    | undefined;
  if (!persona) return steamId64;
  for (const key of ['player_name', 'persona_name', 'personaName', 'name']) {
    const v = persona[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return steamId64;
}
