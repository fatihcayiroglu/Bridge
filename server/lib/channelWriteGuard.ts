/**
 * P7 D2 (#321): authoritative expiry check for WRITES into a channel.
 *
 * Reads already recheck PostgreSQL (lib/channelReadExpiryGuard.ts) because the 60 s channel cache is not expiry authority.
 * A write must not depend on a stale cached channel either. This reuses the same live row + tombstone + database-clock query.
 *
 * Today no endpoint can set an expiry, so every channel is permanent and the answer is always "live". This is the denial
 * path that must exist BEFORE expiry can be set (see docs/P7_D2_EXPIRY_FOUNDATION.md); it is not the expiry feature.
 */
import { channelLiveForMessageRead, type ChannelReadQuery } from './channelReadExpiryGuard';
import { classifyChannelExpiryWithTombstone } from './channelExpiry';

export type ChannelWriteAvailability = 'live' | 'gone' | 'unverifiable';

export interface ChannelWriteDb {
  _pool?: ChannelReadQuery | null;
}

/**
 * `gone`: expired, tombstoned or missing. `unverifiable`: the store could not answer; callers must refuse the write
 * (fail closed) rather than assume the channel is live. Never throws.
 */
export async function channelWriteAvailability(
  db: ChannelWriteDb | null | undefined,
  channel: { _id?: unknown; serverId?: unknown; expiresAt?: unknown; expiryVersion?: unknown } | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ChannelWriteAvailability> {
  if (!channel || typeof channel._id !== 'string' || typeof channel.serverId !== 'string') return 'gone';
  if (db?._pool) {
    try {
      return (await channelLiveForMessageRead(db._pool, channel._id, channel.serverId)) ? 'live' : 'gone';
    } catch {
      return 'unverifiable';
    }
  }
  if (env.NODE_ENV === 'test') {
    // The in-memory test database has no PostgreSQL pool or tombstone collection: judge the record itself, fail closed.
    try {
      return classifyChannelExpiryWithTombstone(channel, null, Date.now()).accessible ? 'live' : 'gone';
    } catch {
      return 'gone';
    }
  }
  return 'unverifiable';
}
