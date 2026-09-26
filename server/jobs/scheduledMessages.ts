// server/jobs/scheduledMessages.ts — Scheduled message dispatcher
import logger from '../lib/logger';
import { normalizeMessageText, RAW_TEXT_FORMAT } from '../lib/storedText';
import { v4 as uuidv4 } from 'uuid';
import type { Server as SocketServer } from 'socket.io';

import { ScheduledMessages, Users, Messages, Members, Channels } from '../db/repositories';
import { publishPersistedMessage } from '../lib/channelActivity';
import { hasPermission, PERMS, resolvePermissions } from '../lib/permissions';
import { parsePersistedNonNegativeInteger } from '../lib/persistedInteger';

let _io: SocketServer | null = null;
let _scheduledInterval: ReturnType<typeof setInterval> | null = null;
const WORKER_ID = `scheduled:${process.pid}:${uuidv4()}`;
const LEASE_MS = 120_000;
const CLAIM_BATCH = 50;
const MAX_RETRY_DELAY_MS = 5 * 60_000;
// Persistent failures must not churn forever. dispatchAttempts is incremented
// atomically when a row is claimed, so this bound is stable across restarts.
const MAX_DISPATCH_ATTEMPTS = 8;

export function startScheduledJob(io: SocketServer | null): void {
  if (_scheduledInterval !== null) return;

  _io = io;
  _scheduledInterval = setInterval(dispatchDue, 30_000);
  _scheduledInterval.unref?.();
  logger.info('   ✅ Scheduled Message Job (30s interval)');
}

export function stopScheduledJob(): void {
  if (_scheduledInterval) {
    clearInterval(_scheduledInterval);
    _scheduledInterval = null;
    logger.info('[ScheduledMessages] Job durduruldu');
  }
}

function normalizedAttempts(value: unknown): number {
  try {
    const attempts = parsePersistedNonNegativeInteger(value, 'scheduled-message dispatch attempts', { max: 2_147_483_647 });
    return attempts >= 1 ? attempts : MAX_DISPATCH_ATTEMPTS;
  } catch {
    // Corrupt persisted attempt state must never create an endless retry loop.
    return MAX_DISPATCH_ATTEMPTS;
  }
}


function retryDelay(attempts: number): number {
  const exp = Math.max(0, Math.min(attempts - 1, 4));
  return Math.min(30_000 * (2 ** exp), MAX_RETRY_DELAY_MS);
}

async function verifyDispatchAuthority(scheduled: {
  userId: string;
  serverId: string;
  channelId: string;
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const user = await Users.findById(scheduled.userId);
  if (!user) return { ok: false, reason: 'user_not_found' };

  const member = await Members.findOne(scheduled.userId, scheduled.serverId);
  if (!member) return { ok: false, reason: 'membership_revoked' };

  const channel = await Channels.findById(scheduled.channelId) as { serverId?: string } | null;
  if (!channel || String(channel.serverId ?? '') !== scheduled.serverId) {
    return { ok: false, reason: 'channel_scope_invalid' };
  }

  const perms = await resolvePermissions(scheduled.userId, scheduled.serverId, scheduled.channelId);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.SEND_MESSAGES)) {
    return { ok: false, reason: 'send_permission_revoked' };
  }

  return { ok: true };
}

async function dispatchDue(): Promise<void> {
  try {
    const now = Date.now();
    const due = await ScheduledMessages.claimDueBefore(now, WORKER_ID, LEASE_MS, CLAIM_BATCH);
    for (const scheduled of due) {
      try {
        const authority = await verifyDispatchAuthority(scheduled);
        if (!authority.ok) {
          await ScheduledMessages.markFailed(scheduled._id, WORKER_ID, authority.reason, now);
          logger.warn(
            { event: 'scheduled_msg_authority_revoked', id: scheduled._id, reason: authority.reason },
            'Scheduled message was not dispatched because current authorization no longer permits it',
          );
          continue;
        }

        // Crash recovery: a previous worker may have committed the message and
        // died before finalizing the schedule. Reuse it instead of duplicating.
        let msg = await Messages.findByScheduledId(scheduled._id);
        if (!msg) {
          const user = await Users.findById(scheduled.userId);
          if (!user) {
            await ScheduledMessages.markFailed(scheduled._id, WORKER_ID, 'user_not_found', now);
            continue;
          }

          msg = await Messages.create({
            _id:         uuidv4(),
            channelId:   scheduled.channelId,
            serverId:    scheduled.serverId,
            userId:      scheduled.userId,
            username:    user.username || scheduled.username,
            displayName: user.displayName || scheduled.displayName,
            avatarColor: user.avatarColor || scheduled.avatarColor,
            content:     normalizeMessageText(scheduled.content),
            contentFormat: RAW_TEXT_FORMAT,
            type:        'normal',
            reactions:   {},
            createdAt:   now,
            scheduledId: scheduled._id,
          });
        }

        const finalized = await ScheduledMessages.finalizeSent(scheduled._id, WORKER_ID, now);
        if (!finalized) {
          throw new Error('scheduled_claim_lost_before_finalize');
        }

        // A scheduled post used to skip history-cache invalidation: its author reloading
        // within the cache TTL did not see the message they had scheduled.
        await publishPersistedMessage(_io, msg);
      } catch (msgErr) {
        const err = msgErr as Error;
        const attempts = normalizedAttempts(scheduled.dispatchAttempts);
        const reason = err.message || 'dispatch_failed';

        if (attempts >= MAX_DISPATCH_ATTEMPTS) {
          try {
            await ScheduledMessages.markFailed(
              scheduled._id, WORKER_ID, `dispatch_retry_exhausted:${reason}`, Date.now(),
            );
          } catch (markErr) {
            // A persistence outage for one poisoned schedule must not abort the
            // rest of this claimed batch. Its lease will expire and recovery
            // can retry/quarantine it later.
            logger.error(
              { event: 'scheduled_msg_mark_failed_persist_fail', id: scheduled._id, err: (markErr as Error).message },
              'Failed to persist terminal scheduled-message failure',
            );
          }
          logger.error(
            { event: 'scheduled_msg_retry_exhausted', id: scheduled._id, attempts },
            'Scheduled message reached the bounded dispatch retry limit',
          );
          continue;
        }

        const retryAt = Date.now() + retryDelay(attempts);
        await ScheduledMessages.releaseClaim(scheduled._id, WORKER_ID, reason, retryAt)
          .catch((releaseErr) => {
            logger.error(
              { event: 'scheduled_msg_release_fail', id: scheduled._id, err: (releaseErr as Error).message },
              'Failed to release scheduled-message lease after dispatch error',
            );
          });
        logger.error(
          { event: 'scheduled_msg_dispatch_fail', id: scheduled._id, attempts, retryAt },
          reason,
        );
      }
    }
  } catch (e) {
    const err = e as Error;
    logger.error({ event: '[scheduled]' }, 'dispatch error: ' + err.message);
  }
}

// Explicit test hook: no production caller should invoke dispatch directly.
export const _dispatchDueForTest = dispatchDue;
