import db from '../db/loader';
import { Channels } from '../db/repositories';
import { channelLiveForMessageRead } from './channelReadExpiryGuard';
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
