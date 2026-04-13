import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import SteamCommunity from 'steamcommunity';
import SteamUser from 'steam-user';
import TradeOfferManager from 'steam-tradeoffer-manager';
import SteamTotp from 'steam-totp';
import { env } from '@/env.ts';

/** Team Fortress 2 — used for `gamesPlayed` so inventory/trade views match TF2 context. */
const TF2_APP_ID = 440;

export type SteamContext = {
  user: SteamUser;
  community: SteamCommunity;
  tradeOfferManager: TradeOfferManager;
  /** Mobile confirmations (pass to `acceptConfirmationForObject` in later phases). */
  identitySecret: string;
};

let context: SteamContext | null = null;

export function getSteamContext(): SteamContext | null {
  return context;
}

function projectRootDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function shutdownSteam(): void {
  const ctx = context;
  if (!ctx) {
    return;
  }
  try {
    ctx.user.logOff();
  } catch (err) {
    console.error('[steam] logOff failed:', err);
  }
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

  const user = new SteamUser({
    dataDirectory,
    autoRelogin: true
  });

  const community = new SteamCommunity();
  const tradeOfferManager = new TradeOfferManager({
    steam: user,
    community,
    domain: 'vidya-steam-bot.local',
    language: 'en'
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

    const onStartupError = (err: Error): void => {
      if (!sessionReady) {
        reject(err);
      } else {
        console.error('[steam] SteamUser error:', err.message);
      }
    };

    user.once('error', onStartupError);

    user.on('loggedOn', () => {
      console.log('[steam] Logged on to Steam.');
      user.setPersona(SteamUser.EPersonaState.Online);
      user.gamesPlayed([TF2_APP_ID]);
    });

    user.on('disconnected', (eresult, msg) => {
      console.warn(`[steam] Disconnected (eresult=${String(eresult)}${msg ? ` ${msg}` : ''})`);
    });

    user.on('error', (err) => {
      if (sessionReady) {
        console.error('[steam] SteamUser error:', err instanceof Error ? err.message : String(err));
      }
    });

    user.on('webSession', (_sessionId, cookies) => {
      community.setCookies(cookies);
      tradeOfferManager.setCookies(cookies, (err: Error | null) => {
        if (err) {
          console.error('[steam] TradeOfferManager.setCookies failed:', err.message);
          if (!sessionReady) {
            user.off('error', onStartupError);
            reject(err);
          }
          return;
        }

        if (!sessionReady) {
          sessionReady = true;
          user.off('error', onStartupError);
          console.log('[steam] TradeOfferManager ready (webSession cookies applied).');
          resolve(context!);
        } else {
          console.log('[steam] Web session refreshed; cookies updated.');
        }
      });
    });

    user.logOn({
      accountName: env.STEAM_ACCOUNT_NAME,
      password: env.STEAM_PASSWORD,
      twoFactorCode: SteamTotp.generateAuthCode(env.STEAM_SHARED_SECRET)
    });
  });
}
