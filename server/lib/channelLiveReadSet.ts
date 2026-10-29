/**
 * P7 D2: route-level entry to the authoritative batch expiry check.
 *
 * Production and real-PG tests always query PostgreSQL. The in-memory unit
 * test store has no pool or tombstone table; only under NODE_ENV=test does it
 * classify the stored channel record the caller passed (no record means a
 * legacy permanent channel, as in the unit store; any expiry metadata on the
 * record fails closed). Without a pool in any other environment this throws,
 * so callers answer 503 instead of serving content they cannot prove is live.
 */
import db from '../db/loader';
import { classifyChannelExpiryWithTombstone } from './channelExpiry';
import { liveChannelIdsForRead, type ChannelPair } from './channelReadExpiryGuard';
import { readableChannelIds } from './permissions';

export class ChannelAvailabilityUnverifiable extends Error {
  constructor() { super('Channel availability could not be verified'); }
}

export async function liveChannelSet(pairs: ReadonlyArray<ChannelPair>): Promise<Set<string>> {
  if (!pairs.length) return new Set();
  if (db._pool) {
    try {
      return await liveChannelIdsForRead(db._pool, pairs);
    } catch {
      throw new ChannelAvailabilityUnverifiable();
    }
  }
  if (process.env.NODE_ENV !== 'test') throw new ChannelAvailabilityUnverifiable();
  const live = new Set<string>();
  for (const pair of pairs) {
    if (typeof pair.channelId !== 'string' || !pair.channelId || typeof pair.serverId !== 'string') continue;
    const record = pair.channel && typeof pair.channel === 'object'
      ? pair.channel as Record<string, unknown>
      : { _id: pair.channelId, serverId: pair.serverId };
    if (record.serverId !== undefined && record.serverId !== pair.serverId) continue;
    if (classifyChannelExpiryWithTombstone(record, null, Date.now()).accessible) live.add(pair.channelId);
  }
  return live;
}

/** VIEW_CHANNELS + READ_HISTORY first, then live: what AI and analytics may read. */
export async function liveReadableChannelIds(
  userId: string, serverId: string, channelIds: ReadonlyArray<string>,
): Promise<Set<string>> {
  const readable = await readableChannelIds(userId, serverId, channelIds);
  return liveChannelSet([...readable].map(channelId => ({ channelId, serverId })));
}

/** One channel record the caller already loaded. Throws ChannelAvailabilityUnverifiable. */
export async function channelRecordIsLive(channel: { _id: unknown; serverId: unknown }): Promise<boolean> {
  const channelId = String(channel._id ?? '');
  const serverId = String(channel.serverId ?? '');
  if (!channelId || !serverId) return false;
  return (await liveChannelSet([{ channelId, serverId, channel }])).has(channelId);
}

/** Router-level error middleware: an unverifiable check is a 503, never content. */
export function channelAvailabilityErrors(
  err: unknown, _req: unknown, res: { headersSent?: boolean; status(code: number): { json(body: unknown): unknown } },
  next: (err?: unknown) => void,
): void {
  if (!(err instanceof ChannelAvailabilityUnverifiable) || res.headersSent) return next(err);
  res.status(503).json({ error: 'Channel availability could not be verified' });
}
