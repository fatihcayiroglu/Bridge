/**
 * Tells the members of a server that its channel list may have changed.
 *
 * The payload is the server id only. Channel visibility is per member (private
 * channels, permission overrides), so no name, id or type is broadcast; every
 * client refetches GET /servers/:sid/channels, which applies its own
 * permissions. Before this, an already-open client never learned about a
 * channel another member created, renamed or deleted until something else
 * forced a reload (P7 D2 lifecycle journey).
 */
export const CHANNELS_CHANGED_EVENT = 'channels:changed';

export interface ChannelListBroadcaster { to(room: string): { emit(event: string, payload: unknown): unknown } }

function isBroadcaster(value: unknown): value is ChannelListBroadcaster {
  return typeof value === 'object' && value !== null && typeof (value as { to?: unknown }).to === 'function';
}

/** Best effort: the mutation already committed and a missed signal only delays a refresh. */
export function announceChannelListChanged(io: unknown, serverId: string): void {
  if (!isBroadcaster(io) || typeof serverId !== 'string' || !serverId) return;
  try {
    io.to(`server:${serverId}`).emit(CHANNELS_CHANGED_EVENT, { serverId });
  } catch {
    /* the next resume/reconnect reload converges the list */
  }
}
