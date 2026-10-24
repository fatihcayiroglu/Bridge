import db from '../db/loader';
import { Channels } from '../db/repositories';
import { channelLiveForMessageRead, channelLiveWindowForRead } from './channelReadExpiryGuard';
import { classifyChannelExpiryWithTombstone } from './channelExpiry';

export type ChannelContentAvailability = 'live' | 'missing' | 'unavailable';

/** Lifecycle preflight only; callers must retain membership and permissions. */
export async function channelContentAvailability(
  channelId: string, serverId: string,
): Promise<ChannelContentAvailability> {
  if (typeof channelId !== 'string' || typeof serverId !== 'string' ||
      !channelId || !serverId || channelId.length > 256 || serverId.length > 256) return 'missing';
  try {
    if (db._pool) {
      return await channelLiveForMessageRead(db._pool, channelId, serverId) ? 'live' : 'missing';
    }
    if (process.env.NODE_ENV !== 'test') return 'unavailable';
    // Legacy unit mocks lack the PG pool and tombstone store. Verify their
    // canonical parent channel; a thread without expiry columns is not proof.
    const channel = await Channels.findById(channelId);
    if (!channel || channel._id !== channelId || channel.serverId !== serverId) return 'missing';
    return classifyChannelExpiryWithTombstone(channel, null, Date.now()).accessible ? 'live' : 'missing';
  } catch {
    return 'unavailable';
  }
}

/**
 * Live media admission (voice, Stage, SFU, voice messages), and for how long a
 * positive answer may be reused: `remainingMs` is the time left before the
 * channel's authoritative expiresAt by the database clock (null: permanent).
 * A channel that is expired, tombstoned, in another tenant, missing, or whose
 * state cannot be verified is not live: media control paths fail closed.
 */
export async function channelMediaLiveWindow(
  channelId: string, serverId: string,
): Promise<{ live: boolean; remainingMs: number | null }> {
  const closed = { live: false, remainingMs: 0 };
  if (typeof channelId !== 'string' || typeof serverId !== 'string' ||
      !channelId || !serverId || channelId.length > 256 || serverId.length > 256) return closed;
  try {
    if (db._pool) return await channelLiveWindowForRead(db._pool, channelId, serverId);
    if (process.env.NODE_ENV !== 'test') return closed;
    // Unit store only (no pool, no tombstones): the canonical channel record.
    const channel = await Channels.findById(channelId);
    if (!channel || channel._id !== channelId || channel.serverId !== serverId) return closed;
    const now = Date.now();
    const decision = classifyChannelExpiryWithTombstone(channel, null, now);
    if (!decision.accessible) return closed;
    const expiresAt = (channel as { expiresAt?: unknown }).expiresAt;
    return { live: true, remainingMs: typeof expiresAt === 'number' ? expiresAt - now : null };
  } catch {
    return closed;
  }
}

export async function channelLiveForMedia(channelId: string, serverId: string): Promise<boolean> {
  return (await channelMediaLiveWindow(channelId, serverId)).live;
}
