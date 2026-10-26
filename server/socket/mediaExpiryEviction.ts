// server/socket/mediaExpiryEviction.ts
//
// P7 D2: live media ends at the channel's expiry instant, not at the worker's
// claim (up to a minute later, best effort).
//
// Admission and every media control path already refuse an expired channel,
// but media that is already flowing is not a control request: an SFU peer
// keeps its transports and P2P peers keep their connections until something
// ends them. When a media room is joined on an expiring channel, the node arms
// one timer per channel for its authoritative expiresAt. On firing it re-reads
// PostgreSQL; if the channel is gone it runs the same all-node eviction the
// expiry worker runs at claim time (SFU peers torn down server-side, P2P peers
// told to leave). If the owner extended the expiry, it re-arms for the new one.
//
// The deadline is the local monotonic time at which the read was SENT plus
// (expiresAt - database now). The database clock was sampled after the send,
// so the timer can only fire early (then it re-reads and re-arms), never late.

import type { Server as SocketIOServer } from 'socket.io';
import { channelMediaLiveWindow } from '../lib/channelContentAvailability';
import { evictSocketsWithoutChannelAccessBestEffort } from '../lib/liveMembership';
import logger from '../lib/logger';
import { logRoutineMediaInfo } from '../lib/routineMediaLog';

/** setTimeout's ceiling is ~24.8 days; a longer expiry re-arms on firing. */
const MAX_DELAY_MS = 6 * 60 * 60 * 1000;

const armed = new Map<string, { timer: ReturnType<typeof setTimeout>; deadline: number }>();

function canEvict(io: unknown): io is SocketIOServer {
  return typeof (io as { in?: unknown } | null)?.in === 'function';
}

function arm(io: SocketIOServer, channelId: string, serverId: string, deadline: number): void {
  const existing = armed.get(channelId);
  if (existing && existing.deadline <= deadline) return;
  if (existing) clearTimeout(existing.timer);
  const delay = Math.min(Math.max(0, deadline - performance.now()), MAX_DELAY_MS);
  const timer = setTimeout(() => { void fire(io, channelId, serverId); }, delay);
  timer.unref?.();
  armed.set(channelId, { timer, deadline });
}

async function fire(io: SocketIOServer, channelId: string, serverId: string): Promise<void> {
  armed.delete(channelId);
  try {
    const sentAt = performance.now();
    const window = await channelMediaLiveWindow(channelId, serverId);
    if (window.live) {
      if (window.remainingMs !== null) arm(io, channelId, serverId, sentAt + window.remainingMs);
      return;
    }
    // Gone (or unverifiable at its expiry instant: fail closed, as admission does).
    await evictSocketsWithoutChannelAccessBestEffort(io, serverId, channelId, { channelGone: true });
    logRoutineMediaInfo({ event: 'media.expiry_evicted' });
  } catch (err) {
    logger.warn({ event: 'media.expiry_evict_failed', channelId, err }, 'Live media expiry eviction failed');
  }
}

/**
 * Arm the expiry-instant eviction for a media room just admitted. Cheap to call
 * on every admission: one authoritative read, at most one timer per channel.
 * Permanent channels and rooms without a server (group DMs) arm nothing.
 */
export async function armMediaExpiryEviction(io: unknown, channelId: string, serverId: string | null | undefined): Promise<void> {
  if (!serverId || !channelId || !canEvict(io)) return;
  const sentAt = performance.now();
  const window = await channelMediaLiveWindow(channelId, serverId);
  if (window.live && window.remainingMs !== null) arm(io, channelId, serverId, sentAt + window.remainingMs);
}

/** Test-only: pending timers and their reset. */
export function __armedMediaExpiryForTest(): string[] {
  return [...armed.keys()];
}
export function __resetMediaExpiryEvictionForTest(): void {
  for (const entry of armed.values()) clearTimeout(entry.timer);
  armed.clear();
}
