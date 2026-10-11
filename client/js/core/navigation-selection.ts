// Durable navigation preferences for WebView/Electron/browser reloads.
//
// Only server/channel IDs are retained. Each key is scoped to the authenticated
// user and cannot make a channel accessible: the caller MUST intersect a
// remembered ID with the current server's authorized API response.
const PREFIX = 'bridge:last-navigation:v1';

export function navigationOwner(user: unknown): string | null {
  if (!user || typeof user !== 'object') return null;
  const u = user as { _id?: unknown; id?: unknown };
  const id = typeof u._id === 'string' ? u._id : u.id;
  return typeof id === 'string' && id.length > 0 && id.length <= 128 ? id : null;
}

function key(kind: string, userId: string, serverId?: string): string {
  return `${PREFIX}:${kind}:${userId}${serverId ? `:${serverId}` : ''}`;
}

function usable(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

export function rememberServer(userId: string | null, serverId: string): void {
  if (!userId || !usable(serverId)) return;
  try { localStorage.setItem(key('server', userId), serverId); } catch { /* storage disabled */ }
}

export function lastServer(userId: string | null): string | null {
  if (!userId) return null;
  try {
    const id = localStorage.getItem(key('server', userId));
    return usable(id) ? id : null;
  } catch { return null; }
}

export function rememberTextChannel(userId: string | null, serverId: string, channelId: string): void {
  if (!userId || !usable(serverId) || !usable(channelId)) return;
  try { localStorage.setItem(key('channel', userId, serverId), channelId); } catch { /* storage disabled */ }
}

export function lastTextChannel(userId: string | null, serverId: string): string | null {
  if (!userId || !usable(serverId)) return null;
  try {
    const id = localStorage.getItem(key('channel', userId, serverId));
    return usable(id) ? id : null;
  } catch { return null; }
}
