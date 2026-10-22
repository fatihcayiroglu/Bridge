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

const POLL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

export async function runChannelExpiryJobTick(): Promise<void> {
  if (running) return;
  const pool = (db as unknown as { _pool?: ExpiryPool })._pool;
  if (!pool) return;
  running = true;
  try {
    const report = await runChannelExpiryTick(pool);
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

export function startChannelExpiryJob(): void {
  if (timer) return;
  timer = setInterval(() => { void runChannelExpiryJobTick(); }, POLL_MS);
  timer.unref?.();
}

export function stopChannelExpiryJob(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
