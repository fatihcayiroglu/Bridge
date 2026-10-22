// client/js/core/channel-list/access-revocation.ts
//
// What the client does when the server says access changed (Final21 Phase 16).
//
// MEASURED GAP: the server already evicted sockets and emitted `membership:revoked` on
// kick/ban — and, since Phase 16, `channel:access-revoked` when a permission change hides a
// channel. No client code listened to either. A removed member kept looking at the server,
// its channel list and a message view that would never update again; a member who lost a
// channel kept it open until they happened to click elsewhere. `permissions:updated` was only
// used by the soundboard, so channels that became visible or hidden never changed in the
// sidebar either.
//
// This module is the decision, not the effect: it maps an event to what the channel list and
// server rail must do, so the rules are testable without a DOM or a socket.

// P7 D2: `channel:expired` carries only the serverId (a private channel's id is not
// broadcast to members who cannot see it); the reload drops the expired channel.
// `channels:changed` (server id only) follows any channel or category create/update/delete by
// another member or device; the list reloads through the permission-filtered endpoint.
export type AccessEvent = 'membership:revoked' | 'channel:access-revoked' | 'permissions:updated' | 'channel:expired'
  | 'channels:changed';

export interface AccessContext {
  /** Server the user is looking at right now (null on home / DMs). */
  currentServerId: string | null;
  /** Channel open in the message view (null when none). */
  activeChannelId: string | null;
}

export interface AccessReaction {
  /** Reload the server rail — the server may be gone. */
  reloadServers: boolean;
  /** Force-reload the channel list of this server (null = nothing to reload). */
  reloadChannelsOf: string | null;
  /** Tell the user why the view changed. Only when something they were looking at went away. */
  notice: 'server-access-lost' | 'channel-access-lost' | null;
}

const NOTHING: AccessReaction = Object.freeze({ reloadServers: false, reloadChannelsOf: null, notice: null });

function stringField(payload: unknown, key: string): string {
  const value = (payload as Record<string, unknown> | null | undefined)?.[key];
  return typeof value === 'string' ? value : '';
}

export function decideAccessReaction(event: AccessEvent, payload: unknown, context: AccessContext): AccessReaction {
  const serverId = stringField(payload, 'serverId');
  if (!serverId) return NOTHING;
  const looking = context.currentServerId === serverId;

  if (event === 'membership:revoked') {
    // The rail must drop the server wherever the user is; only interrupt them with a notice
    // when they were actually inside it.
    return { reloadServers: true, reloadChannelsOf: null, notice: looking ? 'server-access-lost' : null };
  }

  // Channel-level changes only matter for the server on screen; other servers reload their
  // list when the user switches to them.
  if (!looking) return NOTHING;

  if (event === 'channel:access-revoked') {
    const channelId = stringField(payload, 'channelId');
    const wasOpen = channelId !== '' && channelId === context.activeChannelId;
    return { reloadServers: false, reloadChannelsOf: serverId, notice: wasOpen ? 'channel-access-lost' : null };
  }

  // permissions:updated / channel:expired / channels:changed — channels may have appeared or disappeared.
  return { reloadServers: false, reloadChannelsOf: serverId, notice: null };
}

/**
 * After the reload a `channel:expired` event triggered: was the channel the user had open
 * the one that went away? Only then is the user told why their view changed.
 */
export function openChannelExpired(openBefore: string | null, channelIdsAfter: readonly string[]): boolean {
  return openBefore !== null && openBefore !== '' && !channelIdsAfter.includes(openBefore);
}

/**
 * After an authorized reload: is the open channel still in the list the server returned?
 * If not, the view must let go of it; otherwise it keeps rendering a channel the user can no
 * longer read (and the list's auto-select never runs, because a channel is still "active").
 */
export function activeChannelSurvives(activeChannelId: string | null, channelIds: readonly string[]): boolean {
  if (!activeChannelId) return true;
  return channelIds.includes(activeChannelId);
}

/**
 * P7 D2: an Android/iOS WebView suspended in the background, or a client that
 * was offline, can miss `channel:expired` (and access changes) entirely; the
 * socket may even stay "connected". After a foreground resume or a socket
 * reconnect the current server's list is therefore fetched again, which also
 * drops a vanished open channel and purges its local copies. Native and
 * browser lifecycle events often fire together; near-duplicates coalesce.
 */
export const RESUME_RELOAD_COALESCE_MS = 2_000;
/**
 * A browser tab that was merely hidden keeps its socket; only a hidden period
 * long enough for a mobile WebView to be suspended triggers a refetch on
 * `visibilitychange`. Native app resume, bfcache restore and socket reconnect
 * always refetch.
 */
export const RESUME_HIDDEN_MIN_MS = 30_000;

export function resumeReloadDue(serverId: string | null, lastReloadAt: number, now: number): boolean {
  if (!serverId) return false;
  return lastReloadAt === 0 || now - lastReloadAt >= RESUME_RELOAD_COALESCE_MS;
}

/** Trailing window that folds a burst of `channels:changed` events into one list refetch. */
export const CHANNELS_CHANGED_COALESCE_MS = 150;
