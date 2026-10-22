/**
 * P7 D2: periodic driver for lib/channelExpiryWorker.ts.
 *
 * Safe on every node at once: claims use FOR UPDATE SKIP LOCKED and cleanup
 * passes lock their tombstone the same way. When nothing is due, each tick
 * is one indexed query that finds nothing.
 */
import db from '../db/loader';
import logger from '../lib/logger';
import { runChannelExpiryTick, type ExpiryPool } from '../lib/channelExpiryWorker';
import { invalidateChannelMessages } from '../lib/messageCache';
import { invalidateChannelList } from '../routes/servers/channels';
import { evictSocketsWithoutChannelAccessBestEffort } from '../lib/liveMembership';
import type { Server as SocketIOServer } from 'socket.io';

/** The slice of socket.io the job needs; with the Redis adapter it reaches every node. */
export interface ExpiryBroadcaster { to(room: string): { emit(event: string, payload: unknown): unknown } }

/** A full socket.io server can also evict the channel's live room members. */
function canEvict(io: ExpiryBroadcaster | null): io is ExpiryBroadcaster & SocketIOServer {
  return typeof (io as { in?: unknown } | null)?.in === 'function';
}

const POLL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;
let broadcaster: ExpiryBroadcaster | null = null;

/**
 * Runs after the claim committed, so clients never hear about a channel that
 * is still readable. Each channel is claimed by exactly one node, so it is
 * announced once. Failures here never undo or repeat a claim.
 */
async function announceExpired(channels: ReadonlyArray<{ channelId: string; serverId: string }>): Promise<void> {
  for (const { channelId, serverId } of channels) {
    try {
      await invalidateChannelList(serverId);
      await invalidateChannelMessages(channelId);
      // Server id only: members who cannot see a private channel do not learn its id.
      broadcaster?.to(`server:${serverId}`).emit('channel:expired', { serverId });
      // Sockets already in the channel's rooms (text, voice, threads) leave them
      // on every node: typing relays and live voice never touch the database,
      // so the write barrier alone would not stop them.
      if (canEvict(broadcaster)) {
        await evictSocketsWithoutChannelAccessBestEffort(broadcaster, serverId, channelId, { channelGone: true });
      }
    } catch (error) {
      logger.warn({ event: 'channel.expiry.announce_failed', channelId, error }, 'Channel expiry announcement failed');
    }
  }
}

export async function runChannelExpiryJobTick(): Promise<void> {
  if (running) return;
  const pool = (db as unknown as { _pool?: ExpiryPool })._pool;
  if (!pool) return;
  running = true;
  try {
    const report = await runChannelExpiryTick(pool);
    await announceExpired(report.claimedChannels ?? []);
    if (report.claimed.length || report.converged.length || report.deleted) {
      logger.info({ event: 'channel.expiry.tick', claimed: report.claimed.length,
        converged: report.converged.length, deleted: report.deleted }, 'Channel expiry tick');
    }
  } catch (error) {
    logger.error({ event: 'channel.expiry.tick_failed', error }, 'Channel expiry tick failed');
  } finally {
    running = false;
  }
}

export function startChannelExpiryJob(io?: ExpiryBroadcaster | null): void {
  if (io) broadcaster = io;
  if (timer) return;
  timer = setInterval(() => { void runChannelExpiryJobTick(); }, POLL_MS);
  timer.unref?.();
}

export function stopChannelExpiryJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
  broadcaster = null;
}
