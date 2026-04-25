import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import SteamCommunity from 'steamcommunity';
import SteamUser from 'steam-user';
import TradeOfferManager from 'steam-tradeoffer-manager';
import SteamTotp from 'steam-totp';
import { env } from '@/env.ts';

/** Team Fortress 2 — used for `gamesPlayed` so inventory/trade views match TF2 context. */
export const TF2_APP_ID = 440;
/** TF2 backpack inventory context (Mann Co. inventory). */
export const TF2_CONTEXT_ID = 2;

export type SteamContext = {
  user: SteamUser;
  community: SteamCommunity;
  tradeOfferManager: TradeOfferManager;
  /** Mobile confirmations (pass to `acceptConfirmationForObject` in later phases). */
  identitySecret: string;
};

let context: SteamContext | null = null;
const RELOGIN_ERRORS = new Set(['LoggedInElsewhere', 'LogonSessionReplaced']);
const RELOGIN_BASE_DELAY_MS = 15_000;
const RELOGIN_MAX_ATTEMPTS = 5;
const SESSION_CONFLICT_RETRY_MS = 2 * 60 * 1000;
const HEALTH_CHECK_INTERVAL_MS = 60_000;
const LOGOFF_WAIT_MS = 5_000;

let reloginAttempts = 0;
let reloginTimer: ReturnType<typeof setTimeout> | null = null;
let healthCheckTimer: ReturnType<typeof setInterval> | null = null;
let inSessionConflict = false;
let isShuttingDown = false;
let shutdownPromise: Promise<void> | null = null;

export function getSteamContext(): SteamContext | null {
  return context;
}

function projectRootDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function clearReloginTimer(): void {
  if (reloginTimer) {
    clearTimeout(reloginTimer);
    reloginTimer = null;
  }
}

function clearHealthCheckTimer(): void {
  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }
}

function logOn(user: SteamUser): void {
  user.logOn({
    accountName: env.STEAM_ACCOUNT_NAME,
    password: env.STEAM_PASSWORD,
    twoFactorCode: SteamTotp.generateAuthCode(env.STEAM_SHARED_SECRET)
  });
}

function scheduleRelogin(user: SteamUser, sessionConflict = false): void {
  if (isShuttingDown || reloginTimer) {
    return;
  }

  if (!sessionConflict) {
    if (reloginAttempts >= RELOGIN_MAX_ATTEMPTS) {
      console.error(`[steam] Exceeded ${String(RELOGIN_MAX_ATTEMPTS)} re-login attempts; exiting.`);
      process.exit(1);
    }
    reloginAttempts++;
  }

  const delay = sessionConflict
    ? SESSION_CONFLICT_RETRY_MS
    : RELOGIN_BASE_DELAY_MS * Math.pow(2, reloginAttempts - 1);

  if (sessionConflict) {
    console.warn(`[steam] Session conflict; retrying in ${String(delay / 1000)}s.`);
  } else {
    console.warn(
      `[steam] Scheduling re-login attempt ${String(reloginAttempts)}/${String(RELOGIN_MAX_ATTEMPTS)} in ${String(delay / 1000)}s.`
    );
  }

  reloginTimer = setTimeout(() => {
    reloginTimer = null;
    try {
      logOn(user);
    } catch (err) {
      console.error('[steam] logOn failed:', err);
      scheduleRelogin(user);
    }
  }, delay);
}

function startHealthCheck(user: SteamUser): void {
  clearHealthCheckTimer();

  healthCheckTimer = setInterval(() => {
    if (!user.steamID) {
      console.warn('[steam] Health check failed: not logged in; triggering re-login.');
      scheduleRelogin(user);
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

export async function shutdownSteam(): Promise<void> {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    isShuttingDown = true;
    clearReloginTimer();
    clearHealthCheckTimer();

    const ctx = context;
    context = null;
    if (!ctx) {
      return;
    }

    if (!ctx.user.steamID) {
      return;
    }

    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        ctx.user.off('disconnected', done);
        resolve();
      };
      const timer = setTimeout(() => {
        ctx.user.off('disconnected', done);
        console.warn('[steam] Timed out waiting for Steam logOff disconnect.');
        resolve();
      }, LOGOFF_WAIT_MS);

      try {
        ctx.user.once('disconnected', done);
        ctx.user.logOff();
      } catch (err) {
        clearTimeout(timer);
        ctx.user.off('disconnected', done);
        console.error('[steam] logOff failed:', err);
        resolve();
      }
    });
  })();

  return shutdownPromise;
}

/**
 * Log into Steam, persist session under `./steam-data`, and apply `webSession` cookies to
 * `SteamCommunity` and `TradeOfferManager`.
 */
export async function connectSteam(): Promise<SteamContext> {
  if (context) {
    return context;
  }

  const dataDirectory = join(projectRootDir(), 'steam-data');
  mkdirSync(dataDirectory, { recursive: true });

  const user = new SteamUser({
    dataDirectory,
    autoRelogin: true
  });

  const community = new SteamCommunity();
  const tradeOfferManager = new TradeOfferManager({
    steam: user,
    community,
    domain: 'vidya-steam-bot.local',
    language: 'en',
    pollInterval: 30000
  });

  const identitySecret = env.STEAM_IDENTITY_SECRET;

  context = {
    user,
    community,
    tradeOfferManager,
    identitySecret
  };

  return await new Promise<SteamContext>((resolve, reject) => {
    let sessionReady = false;

    user.on('loggedOn', () => {
      console.log('[steam] Logged on to Steam.');
      const recovered = inSessionConflict || reloginAttempts > 0;

      reloginAttempts = 0;
      inSessionConflict = false;
      clearReloginTimer();

      if (recovered) {
        console.log('[steam] Re-login successful.');
      }

      user.setPersona(SteamUser.EPersonaState.Online);
      user.gamesPlayed([TF2_APP_ID]);
    });

    user.on('disconnected', (eresult, msg) => {
      console.warn(`[steam] Disconnected (eresult=${String(eresult)}${msg ? ` ${msg}` : ''})`);
    });

    user.on('error', (err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[steam] SteamUser error:', message);

      if (RELOGIN_ERRORS.has(message)) {
        inSessionConflict = true;
        scheduleRelogin(user, true);
        return;
      }

      if (!sessionReady || !user.steamID) {
        scheduleRelogin(user);
      }
    });

    community.on('sessionExpired', () => {
      console.warn('[steam] Web session expired; requesting a new web session.');
      try {
        user.webLogOn();
      } catch (err) {
        console.error('[steam] webLogOn failed:', err);
      }
    });

    user.on('webSession', (_sessionId, cookies) => {
      community.setCookies(cookies);
      tradeOfferManager.setCookies(cookies, (err: Error | null) => {
        if (err) {
          console.error('[steam] TradeOfferManager.setCookies failed:', err.message);
          if (!sessionReady) {
            reject(err);
          }
          return;
        }

        if (!sessionReady) {
          sessionReady = true;
          console.log('[steam] TradeOfferManager ready (webSession cookies applied).');
          startHealthCheck(user);
          resolve(context!);
        } else {
          console.log('[steam] Web session refreshed; cookies updated.');
        }
      });
    });

    logOn(user);
  });
}
