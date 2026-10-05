// server/routes/federation/lifecycle.ts
// P6 — outbound lifecycle for Bridge-authored ActivityPub Notes.
//
// Create already exists in activitypub.ts. This router adds the missing C2S
// lifecycle operations without mutating history: every edit/delete is persisted
// as its own ap_activities row and the exact persisted activity is fanned out to
// followers through the durable delivery queue.

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Federation, Users } from '../../db/repositories';
import { authMiddleware, castAuthed } from '../../middleware/auth';
import logger from '../../lib/logger';
import { fanOutActivityToFollowers } from './helpers';

const router = express.Router();
const AP_CONTEXT = 'https://www.w3.org/ns/activitystreams';
const MAX_NOTE_LENGTH = 5000;
const activityPubJsonParser = express.json({
  type: ['application/activity+json', 'application/ld+json', 'application/json'],
});

type ActivityRow = Record<string, unknown> & {
  type?: unknown;
  activity?: unknown;
  publishedAt?: unknown;
  createdAt?: unknown;
};

type NoteState = {
  latest: ActivityRow;
  note: Record<string, unknown> | null;
  deleted: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function instanceUrl(): string {
  return process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
}

function actorUrl(username: string): string {
  return `${instanceUrl()}/api/federation/users/${username}`;
}

function noteApId(username: string, noteId: string): string {
  return `${actorUrl(username)}/notes/${noteId}`;
}

function rowTime(row: ActivityRow): number {
  const published = typeof row.publishedAt === 'number' ? row.publishedAt : Number(row.publishedAt);
  if (Number.isFinite(published)) return published;
  const created = typeof row.createdAt === 'number' ? row.createdAt : Number(row.createdAt);
  return Number.isFinite(created) ? created : 0;
}

async function materializeRows(value: unknown): Promise<ActivityRow[]> {
  const awaited = await value as unknown;
  if (Array.isArray(awaited)) return awaited as ActivityRow[];
  if (awaited && typeof (awaited as { toArray?: unknown }).toArray === 'function') {
    const rows = await (awaited as { toArray: () => Promise<unknown[]> }).toArray();
    return Array.isArray(rows) ? rows as ActivityRow[] : [];
  }
  return [];
}

async function loadNoteState(userId: string, fullNoteId: string): Promise<NoteState | null> {
  const rows = await materializeRows(Federation.findActivities({ actorUserId: userId, noteId: fullNoteId }));
  if (!rows.length) return null;
  rows.sort((a, b) => rowTime(b) - rowTime(a));
  const latest = rows[0]!;
  const latestActivity = isRecord(latest.activity) ? latest.activity : null;
  const latestType = String(latest.type || latestActivity?.type || '');
  if (latestType === 'Delete') return { latest, note: null, deleted: true };

  const object = isRecord(latestActivity?.object) ? latestActivity.object : null;
  if (object?.type === 'Note' && object.id === fullNoteId) {
    return { latest, note: object, deleted: false };
  }

  // Legacy rows may not have an Update as the latest usable object. Walk the
  // durable history newest-first rather than ever inventing a Note body.
  for (const row of rows) {
    const activity = isRecord(row.activity) ? row.activity : null;
    const candidate = isRecord(activity?.object) ? activity.object : null;
    if (candidate?.type === 'Note' && candidate.id === fullNoteId) {
      return { latest, note: candidate, deleted: false };
    }
  }
  return null;
}

async function ownUser(req: import('express').Request, res: import('express').Response) {
  const user = await Users.findByUsername(String(req.params.username ?? ''));
  if (!user) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  if (String(castAuthed(req).user.id) !== String(user._id)) {
    res.status(403).json({ error: 'Cannot mutate notes on behalf of another user' });
    return null;
  }
  return user;
}

/**
 * @openapi
 * /federation/users/{username}/notes/{noteId}:
 *   get:
 *     tags: [Federation]
 *     summary: Read the latest durable state of a local ActivityPub Note
 *     parameters:
 *       - { in: path, name: username, required: true, schema: { type: string } }
 *       - { in: path, name: noteId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Latest Note object }
 *       404: { description: Note not found }
 *       410: { description: Note was deleted and is represented by a Tombstone }
 *   patch:
 *     tags: [Federation]
 *     summary: Edit a local ActivityPub Note and emit Update
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: username, required: true, schema: { type: string } }
 *       - { in: path, name: noteId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content: { type: string, maxLength: 5000 }
 *               sensitive: { type: boolean }
 *               summary: { type: string, nullable: true }
 *     responses:
 *       200: { description: Update persisted and queued for delivery }
 *       400: { description: Invalid content }
 *       401: { description: Authentication required }
 *       403: { description: Cannot edit another user's Note }
 *       404: { description: Note not found }
 *       410: { description: Deleted Notes cannot be resurrected }
 *   delete:
 *     tags: [Federation]
 *     summary: Delete a local ActivityPub Note and emit Delete
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: username, required: true, schema: { type: string } }
 *       - { in: path, name: noteId, required: true, schema: { type: string } }
 *     responses:
 *       204: { description: Delete persisted and queued, or Note already deleted }
 *       401: { description: Authentication required }
 *       403: { description: Cannot delete another user's Note }
 *       404: { description: Note not found }
 */

// Canonical read path for authored notes. Mounted before activitypub.ts so the
// lifecycle-aware state wins over the historical Create-only reader there.
router.get('/users/:username/notes/:noteId', async (req, res) => {
  const user = await Users.findByUsername(String(req.params.username ?? ''));
  if (!user) return res.status(404).json({ error: 'Not found' });
  const fullNoteId = noteApId(user.username, String(req.params.noteId ?? ''));
  const state = await loadNoteState(String(user._id), fullNoteId);
  if (!state) return res.status(404).json({ error: 'Note not found' });

  res.set('Content-Type', 'application/activity+json');
  if (state.deleted) {
    const activity = isRecord(state.latest.activity) ? state.latest.activity : {};
    const deleted = typeof activity.published === 'string'
      ? activity.published
      : new Date(rowTime(state.latest)).toISOString();
    return res.status(410).json({
      '@context': AP_CONTEXT,
      id: fullNoteId,
      type: 'Tombstone',
      formerType: 'Note',
      deleted,
    });
  }
  return res.json(state.note);
});

router.patch('/users/:username/notes/:noteId', activityPubJsonParser, authMiddleware, async (req, res) => {
  const user = await ownUser(req, res);
  if (!user) return;

  const fullNoteId = noteApId(user.username, String(req.params.noteId ?? ''));
  const state = await loadNoteState(String(user._id), fullNoteId);
  if (!state) return res.status(404).json({ error: 'Note not found' });
  if (state.deleted) return res.status(410).json({ error: 'Note has been deleted' });
  if (!state.note) return res.status(409).json({ error: 'Note state is unavailable' });

  const body = isRecord(req.body) ? req.body : {};
  const content = body.content;
  if (typeof content !== 'string' || !content.trim()) {
    return res.status(400).json({ error: 'content is required and must be a string' });
  }
  if (content.length > MAX_NOTE_LENGTH) {
    return res.status(400).json({ error: `content exceeds maximum length of ${MAX_NOTE_LENGTH} characters` });
  }
  if (body.sensitive !== undefined && typeof body.sensitive !== 'boolean') {
    return res.status(400).json({ error: 'sensitive must be a boolean' });
  }
  if (body.summary !== undefined && body.summary !== null && typeof body.summary !== 'string') {
    return res.status(400).json({ error: 'summary must be a string or null' });
  }

  const now = Date.now();
  const updated = new Date(now).toISOString();
  const base = state.note;
  const note: Record<string, unknown> = {
    ...base,
    '@context': base['@context'] ?? AP_CONTEXT,
    id: fullNoteId,
    type: 'Note',
    attributedTo: actorUrl(user.username),
    content: content.trim(),
    updated,
  };
  if (body.sensitive !== undefined) note.sensitive = body.sensitive;
  if (body.summary !== undefined) {
    if (body.summary === null || body.summary === '') delete note.summary;
    else note.summary = body.summary;
  }

  const updateId = `${actorUrl(user.username)}/activities/${uuidv4()}`;
  const updateActivity = {
    '@context': AP_CONTEXT,
    id: updateId,
    type: 'Update',
    actor: actorUrl(user.username),
    published: updated,
    to: Array.isArray(note.to) ? note.to : [],
    cc: Array.isArray(note.cc) ? note.cc : [],
    object: note,
  };

  await Federation.insertActivity({
    _id: uuidv4(),
    actorUserId: user._id,
    type: 'Update',
    activityId: updateId,
    noteId: fullNoteId,
    activity: updateActivity,
    publishedAt: now,
    createdAt: now,
  });

  let delivery = { followers: 0, failed: 0 };
  try {
    delivery = await fanOutActivityToFollowers(user, updateActivity);
  } catch (err) {
    logger.warn({ err, noteId: fullNoteId, event: 'federation.outbox.update_fanout_failed' },
      'ActivityPub Update persisted but follower fanout could not be enumerated.');
    delivery = { followers: 0, failed: 1 };
  }

  return res.status(200).json({ ok: true, id: updateId, noteId: fullNoteId, updated, delivery });
});

router.delete('/users/:username/notes/:noteId', authMiddleware, async (req, res) => {
  const user = await ownUser(req, res);
  if (!user) return;

  const fullNoteId = noteApId(user.username, String(req.params.noteId ?? ''));
  const state = await loadNoteState(String(user._id), fullNoteId);
  if (!state) return res.status(404).json({ error: 'Note not found' });
  if (state.deleted) return res.status(204).send();

  const now = Date.now();
  const published = new Date(now).toISOString();
  const deleteId = `${actorUrl(user.username)}/activities/${uuidv4()}`;
  const deleteActivity = {
    '@context': AP_CONTEXT,
    id: deleteId,
    type: 'Delete',
    actor: actorUrl(user.username),
    published,
    object: fullNoteId,
  };

  await Federation.insertActivity({
    _id: uuidv4(),
    actorUserId: user._id,
    type: 'Delete',
    activityId: deleteId,
    noteId: fullNoteId,
    activity: deleteActivity,
    publishedAt: now,
    createdAt: now,
  });

  try {
    await fanOutActivityToFollowers(user, deleteActivity);
  } catch (err) {
    logger.warn({ err, noteId: fullNoteId, event: 'federation.outbox.delete_fanout_failed' },
      'ActivityPub Delete persisted but follower fanout could not be enumerated.');
  }

  return res.status(204).send();
});

export default router;
module.exports = router;
module.exports.default = router;
