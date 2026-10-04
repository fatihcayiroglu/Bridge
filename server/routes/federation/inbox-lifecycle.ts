// P6 ActivityPub object lifecycle ordering.
//
// Production routes enter through helpers.ts. Create still delegates its full
// audience/DM/notification behavior to the canonical legacy handler, but this
// wrapper adds a persistent lifecycle clock and refuses resurrection after a
// Delete tombstone. Update/Delete are deliberately small and actor-scoped.

import { createHash } from 'crypto';
import { Federation } from '../../db/repositories';
import logger from '../../lib/logger';
import {
  handleApCreate as handleLegacyCreate,
  type ApActivity,
  type ApObject,
} from './inbox-handlers';

type ApActor = { _id: string; username: string };

type LifecycleRow = Record<string, unknown> & {
  apId?: string;
  actorUrl?: string;
  updatedAt?: number | string | null;
  published?: number | string | null;
  createdAt?: number | string | null;
  deletedAt?: number | string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function actorId(actor: ApActivity['actor']): string {
  return typeof actor === 'string' ? actor : actor?.id || '';
}

function objectId(obj: ApActivity['object']): string {
  return typeof obj === 'string' ? obj : isRecord(obj) && typeof obj.id === 'string' ? obj.id : '';
}

function parseApTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  // Persisted epochs occasionally arrive as decimal strings in tests/adapters.
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function lifecycleTime(activity: ApActivity, obj?: ApObject | null): number {
  const activityRecord = activity as unknown as Record<string, unknown>;
  const candidates = [
    obj?.updated,
    obj?.published,
    activityRecord.updated,
    activityRecord.published,
  ];
  for (const candidate of candidates) {
    const parsed = parseApTime(candidate);
    if (parsed !== null) return parsed;
  }
  // Some AP implementations omit lifecycle timestamps. Receipt time is the
  // only deterministic local ordering available for those activities.
  return Date.now();
}

function rowLifecycleTime(row: LifecycleRow | null | undefined): number {
  for (const value of [row?.updatedAt, row?.deletedAt, row?.published, row?.createdAt]) {
    const parsed = parseApTime(value);
    if (parsed !== null) return parsed;
  }
  return 0;
}

function stableTombstoneId(actorUrl: string, apId: string): string {
  return `aptomb_${createHash('sha256').update(`${actorUrl}\u001f${apId}`).digest('hex')}`;
}

/**
 * Create keeps all canonical audience/DM/notification behavior but refuses a
 * redelivery whose object id already belongs to a tombstone. A normal duplicate
 * still goes through the legacy handler so its idempotent notification path is
 * preserved.
 */
export async function handleApCreate(targetUser: ApActor | null, activity: ApActivity): Promise<void> {
  const obj = isRecord(activity.object) ? activity.object as ApObject : null;
  const apId = typeof obj?.id === 'string' ? obj.id : '';
  const actorUrl = actorId(activity.actor);

  if (!apId || !actorUrl) {
    await handleLegacyCreate(targetUser, activity);
    return;
  }

  const existing = await Federation.findApMessageOne({ apId }) as LifecycleRow | null;
  if (existing?.actorUrl && existing.actorUrl !== actorUrl) {
    // Preserve the canonical ownership-conflict logging/notification behavior.
    await handleLegacyCreate(targetUser, activity);
    return;
  }
  if (existing?.deletedAt !== null && existing?.deletedAt !== undefined) {
    logger.info({ apId, actorUrl, event: 'federation.note.create_after_delete_ignored' },
      'Ignoring ActivityPub Create redelivery for a tombstoned object.');
    return;
  }

  await handleLegacyCreate(targetUser, activity);

  // Direct local→local AP DMs are intentionally written to dm_messages by the
  // legacy handler and have no ap_messages row. Updating a non-existent row is
  // therefore a harmless no-op.
  const ts = lifecycleTime(activity, obj);
  await Federation.updateApMessage(
    { apId, actorUrl, deletedAt: null },
    { $set: { updatedAt: ts } },
  );
}

/** Apply only an Update newer than the stored object lifecycle. */
export async function handleApUpdate(_targetUser: ApActor | null, activity: ApActivity): Promise<void> {
  const obj = isRecord(activity.object) ? activity.object as ApObject : null;
  if (!obj || typeof obj.id !== 'string' || !obj.id) return;
  const actorUrl = actorId(activity.actor);
  if (!actorUrl) return;

  const ts = lifecycleTime(activity, obj);
  const existing = await Federation.findApMessageOne({ apId: obj.id }) as LifecycleRow | null;
  if (!existing) return;
  if (existing.actorUrl !== actorUrl) {
    logger.warn({ apId: obj.id, actorUrl, existingActor: existing.actorUrl,
      event: 'federation.note.update_actor_conflict' },
    'Ignoring ActivityPub Update from an actor that does not own the object id.');
    return;
  }
  if (existing.deletedAt !== null && existing.deletedAt !== undefined) {
    logger.info({ apId: obj.id, actorUrl, event: 'federation.note.update_after_delete_ignored' },
      'Ignoring ActivityPub Update for a tombstoned object.');
    return;
  }
  if (ts <= rowLifecycleTime(existing)) {
    logger.info({ apId: obj.id, actorUrl, event: 'federation.note.stale_update_ignored' },
      'Ignoring stale ActivityPub Update.');
    return;
  }

  // The timestamp predicate makes the final write safe against two Updates
  // racing after the read: only the newest generation can advance the row.
  await Federation.updateApMessage(
    { apId: obj.id, actorUrl, deletedAt: null, updatedAt: { $lt: ts } },
    { $set: { content: obj.content || '', updatedAt: ts } },
  );
  logger.info({ noteId: obj.id, event: 'federation.note.updated' });
}

/**
 * Delete becomes a tombstone instead of a physical removal. Existing live rows
 * are scrubbed and hidden from all current read surfaces by switching them to
 * direct visibility with no target; future remote-DM reads additionally filter
 * deletedAt IS NULL. A Delete seen before its Create gets a minimal tombstone.
 */
export async function handleApDelete(_targetUser: ApActor | null, activity: ApActivity): Promise<void> {
  const apId = objectId(activity.object);
  if (!apId) return;
  const actorUrl = actorId(activity.actor);
  if (!actorUrl) return;
  const obj = isRecord(activity.object) ? activity.object as ApObject : null;
  const ts = lifecycleTime(activity, obj);

  const existing = await Federation.findApMessageOne({ apId }) as LifecycleRow | null;
  if (existing) {
    if (existing.actorUrl !== actorUrl) {
      logger.warn({ apId, actorUrl, existingActor: existing.actorUrl,
        event: 'federation.note.delete_actor_conflict' },
      'Ignoring ActivityPub Delete from an actor that does not own the object id.');
      return;
    }
    if (ts <= rowLifecycleTime(existing)) {
      logger.info({ apId, actorUrl, event: 'federation.note.stale_delete_ignored' },
        'Ignoring stale or duplicate ActivityPub Delete.');
      return;
    }

    await Federation.updateApMessage(
      { apId, actorUrl, updatedAt: { $lt: ts } },
      { $set: {
        content: '', summary: null, attachments: [], tags: [],
        targetUserId: null, visibility: 'direct', deletedAt: ts, updatedAt: ts,
      } },
    );
    logger.info({ objectId: apId, event: 'federation.note.deleted' });
    return;
  }

  const tombstone = {
    _id: stableTombstoneId(actorUrl, apId),
    apId,
    actorUrl,
    channelId: null,
    targetUserId: null,
    visibility: 'direct',
    content: '',
    summary: null,
    sensitive: false,
    inReplyTo: null,
    attachments: [],
    tags: [],
    published: null,
    updatedAt: ts,
    deletedAt: ts,
    createdAt: Date.now(),
  };

  try {
    await Federation.insertApMessage(tombstone);
  } catch (err) {
    // A concurrent Create/Delete may win the unique apId race. Re-read and
    // apply the same ordering rule rather than treating that race as loss.
    const raced = await Federation.findApMessageOne({ apId }) as LifecycleRow | null;
    if (!raced || raced.actorUrl !== actorUrl) throw err;
    if (ts > rowLifecycleTime(raced)) {
      await Federation.updateApMessage(
        { apId, actorUrl, updatedAt: { $lt: ts } },
        { $set: {
          content: '', summary: null, attachments: [], tags: [],
          targetUserId: null, visibility: 'direct', deletedAt: ts, updatedAt: ts,
        } },
      );
    }
  }
  logger.info({ objectId: apId, event: 'federation.note.deleted' });
}
