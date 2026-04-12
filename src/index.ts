import { env } from '@/env.ts';

function redactedDatabaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.toString();
  } catch {
    return '(could not parse DATABASE_URL for display)';
  }
}

console.log('[vidya-steam-bot] P0 bootstrap — configuration loaded.');
console.log(`[vidya-steam-bot] API_PORT=${String(env.API_PORT)}`);
console.log(`[vidya-steam-bot] BOT_ADMINS count=${String(env.BOT_ADMINS.length)}`);
console.log(
  `[vidya-steam-bot] REMOVE_FRIEND_AFTER_DELIVERY=${String(env.REMOVE_FRIEND_AFTER_DELIVERY)}`
);
console.log(`[vidya-steam-bot] DATABASE_URL (redacted)=${redactedDatabaseUrl(env.DATABASE_URL)}`);
console.log('[vidya-steam-bot] Steam credentials loaded (not logged). Idle until next phases.');

await new Promise<void>((resolve) => {
  const shutdown = () => {
    console.log('[vidya-steam-bot] Shutting down...');
    resolve();
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
});
