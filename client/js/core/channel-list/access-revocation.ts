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

export type AccessEvent = 'membership:revoked' | 'channel:access-revoked' | 'permissions:updated';

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

  // permissions:updated — channels may have appeared or disappeared.
  return { reloadServers: false, reloadChannelsOf: serverId, notice: null };
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
