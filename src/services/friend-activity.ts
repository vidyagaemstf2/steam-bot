import SteamUser from 'steam-user';
import { hasActiveDeliveryForWinner } from '@/db/pending-deliveries.ts';
import { env } from '@/env.ts';
import type { SteamContext } from '@/steam/session.ts';
import { Colors, notify, steamProfileLink } from '@/utils/discord.ts';

const lastActivity = new Map<string, Date>();

let friendActivityRegistered = false;

export function touchFriendActivity(id64: string): void {
  lastActivity.set(id64, new Date());
}

function initFriendActivityIfAbsent(id64: string): void {
  if (!lastActivity.has(id64)) {
    lastActivity.set(id64, new Date());
  }
}

function initCurrentFriends(user: SteamUser): void {
  for (const [id64, rel] of Object.entries(user.myFriends)) {
    if (rel === SteamUser.EFriendRelationship.Friend) {
      initFriendActivityIfAbsent(id64);
    }
  }
}

/**
 * Registers event listeners that keep the in-memory last-activity map up to date.
 * Must be called once after the Steam session is ready.
 */
export function registerFriendActivity(ctx: SteamContext): void {
  if (friendActivityRegistered) {
    return;
  }
  friendActivityRegistered = true;

  const { user } = ctx;

  // Seed timestamps for friends already in the list (covers the case where
  // friendsList fired before this function was called).
  initCurrentFriends(user);

  // Re-seed on subsequent friendsList events (e.g. after re-login).
  user.on('friendsList', () => {
    initCurrentFriends(user);
  });

  // Record when a new friend relationship is established.
  user.on('friendRelationship', (steamId, relationship) => {
    if (relationship === SteamUser.EFriendRelationship.Friend) {
      touchFriendActivity(steamId.getSteamID64());
    }
  });

  // Record every incoming chat message regardless of content.
  user.chat.on('friendMessage', (msg) => {
    if (msg.local_echo) {
      return;
    }
    touchFriendActivity(msg.steamid_friend.getSteamID64());
  });
}

/**
 * Removes friends who have had no interaction for longer than `INACTIVE_FRIEND_PRUNE_DAYS`,
 * skipping anyone with an active pending delivery.
 *
 * The sweep only activates when the current friend count reaches
 * `FRIEND_PRUNE_THRESHOLD_PCT` percent of `STEAM_FRIEND_LIMIT`, so it is a no-op
 * while the list has plenty of room. Set `INACTIVE_FRIEND_PRUNE_DAYS` to 0 to
 * disable entirely.
 */
export async function runInactiveFriendSweep(ctx: SteamContext): Promise<void> {
  if (env.INACTIVE_FRIEND_PRUNE_DAYS === 0) {
    return;
  }

  const { user } = ctx;

  const friends = Object.entries(user.myFriends).filter(
    ([, rel]) => rel === SteamUser.EFriendRelationship.Friend
  );

  const pruneThreshold = Math.floor(env.STEAM_FRIEND_LIMIT * env.FRIEND_PRUNE_THRESHOLD_PCT / 100);
  if (friends.length < pruneThreshold) {
    console.log(
      `[friend-activity] Skipping inactive sweep: ${String(friends.length)}/${String(env.STEAM_FRIEND_LIMIT)} friends (threshold ${String(pruneThreshold)}).`
    );
    return;
  }

  console.log(
    `[friend-activity] Friend list at ${String(friends.length)}/${String(env.STEAM_FRIEND_LIMIT)} (threshold ${String(pruneThreshold)}); scanning for inactive friends.`
  );

  const pruneAfterMs = env.INACTIVE_FRIEND_PRUNE_DAYS * 24 * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - pruneAfterMs);

  const toRemove: Array<{ id64: string; lastSeen: Date }> = [];

  for (const [id64] of friends) {
    const lastSeen = lastActivity.get(id64);

    if (!lastSeen) {
      // No record yet — seed conservatively and revisit next cycle.
      initFriendActivityIfAbsent(id64);
      continue;
    }

    if (lastSeen >= cutoff) {
      continue;
    }

    try {
      const hasActive = await hasActiveDeliveryForWinner(id64);
      if (hasActive) {
        // Pending delivery in progress — treat as active and reset the clock.
        touchFriendActivity(id64);
        continue;
      }
    } catch (err) {
      console.error(`[friend-activity] DB error checking active delivery for ${id64}:`, err);
      continue;
    }

    toRemove.push({ id64, lastSeen });
  }

  if (toRemove.length === 0) {
    return;
  }

  console.log(
    `[friend-activity] Removing ${String(toRemove.length)} inactive friend(s) (threshold: ${String(env.INACTIVE_FRIEND_PRUNE_DAYS)}d).`
  );

  for (const { id64, lastSeen } of toRemove) {
    console.log(
      `[friend-activity] Removing inactive friend ${id64} (last active: ${lastSeen.toISOString()}).`
    );
    user.removeFriend(id64);
    lastActivity.delete(id64);
  }

  void notify('admin', {
    title: 'Inactive friends removed',
    description: `Removed ${String(toRemove.length)} friend(s) with no interaction in over ${String(env.INACTIVE_FRIEND_PRUNE_DAYS)} day(s).`,
    color: Colors.Yellow,
    fields: toRemove.map(({ id64 }) => ({
      name: id64,
      value: steamProfileLink(id64, id64),
      inline: true
    }))
  });
}
