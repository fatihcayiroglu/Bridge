// P6 — outbound lifecycle for Bridge-authored ActivityPub Notes.
//
// The original C2S outbox only creates Notes. These owner-only endpoints edit
// or delete an existing Bridge-authored Note, rewrite the canonical stored
// Create object so GET /notes/:id reflects current state, and fan out an exact
// Update/Delete activity through the existing durable delivery queue.

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Users, Federation } from '../../db/repositories';
import { authMiddleware, castAuthed } from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { fanOutActivityToFollowers } from './delivery';

const router = express.Router();
const AP_CONTEXT = 'https://www.w3.org/ns/activitystreams';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

async function findStoredCreate(userId: string, noteApId: string): Promise<Record<string, unknown> | null> {
  const found = await Federation.apActivitiesFind({ actorUserId: userId, type: 'Create' }) || [];
  const rows = Array.isArray(found) ? found : await found;
  return rows.find((row: Record<string, unknown>) => {
    const activity = isRecord(row.activity) ? row.activity : null;
    const object = activity && isRecord(activity.object) ? activity.object : null;
    return object?.id === noteApId;
  }) ?? null;
}

function audiences(note: Record<string, unknown>): { to: string[]; cc: string[] } {
  const to = Array.isArray(note.to) ? note.to.filter((v): v is string => typeof v === 'string') : [];
  const cc = Array.isArray(note.cc) ? note.cc.filter((v): v is string => typeof v === 'string') : [];
  return { to, cc };
}

router.patch('/users/:username/notes/:noteId', authMiddleware, limits.federation(), async (req, res) => {
  const callerId = String(castAuthed(req).user.id);
  const user = await Users.findByUsername(String(req.params.username || ''));
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (String(user._id) !== callerId) return res.status(403).json({ error: 'Cannot edit another user\'s federated note' });

  const body = isRecord(req.body) ? req.body : {};
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content) return res.status(400).json({ error: 'content is required and must be a string' });
  if (content.length > 5000) return res.status(400).json({ error: 'content exceeds maximum length of 5000 characters' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl = `${instanceUrl}/api/federation/users/${user.username}`;
  const noteApId = `${actorUrl}/notes/${String(req.params.noteId || '')}`;
  const stored = await findStoredCreate(String(user._id), noteApId);
  if (!stored) return res.status(404).json({ error: 'Note not found' });

  const create = isRecord(stored.activity) ? stored.activity : null;
  const oldNote = create && isRecord(create.object) ? create.object : null;
  if (!create || !oldNote) return res.status(409).json({ error: 'Stored ActivityPub note is invalid' });
  if (oldNote.type === 'Tombstone') return res.status(410).json({ error: 'Note was deleted' });
  if (oldNote.attributedTo !== undefined && oldNote.attributedTo !== actorUrl) {
    return res.status(409).json({ error: 'Stored ActivityPub note ownership is invalid' });
  }

  const updatedAt = new Date().toISOString();
  const nextNote = {
    ...oldNote,
    id: noteApId,
    type: 'Note',
    attributedTo: actorUrl,
    content,
    updated: updatedAt,
  };
  const nextCreate = { ...create, object: nextNote };
  await Federation.updateActivity({ _id: stored._id }, { $set: { activity: nextCreate } });

  const { to, cc } = audiences(nextNote);
  const updateActivity = {
    '@context': AP_CONTEXT,
    id: `${actorUrl}/activities/${uuidv4()}`,
    type: 'Update',
    actor: actorUrl,
    published: updatedAt,
    to,
    cc,
    object: nextNote,
  };
  await Federation.insertActivity({
    _id: uuidv4(),
    actorUserId: user._id,
    type: 'Update',
    activityId: updateActivity.id,
    noteId: noteApId,
    activity: updateActivity,
    publishedAt: Date.now(),
    createdAt: Date.now(),
  });
  const delivery = await fanOutActivityToFollowers(user, updateActivity);

  return res.json({ ok: true, noteId: noteApId, updated: updatedAt, delivery });
});

router.delete('/users/:username/notes/:noteId', authMiddleware, limits.federation(), async (req, res) => {
  const callerId = String(castAuthed(req).user.id);
  const user = await Users.findByUsername(String(req.params.username || ''));
  if (!user) return res.status(404).json({ error: 'Not found' });
  if (String(user._id) !== callerId) return res.status(403).json({ error: 'Cannot delete another user\'s federated note' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const actorUrl = `${instanceUrl}/api/federation/users/${user.username}`;
  const noteApId = `${actorUrl}/notes/${String(req.params.noteId || '')}`;
  const stored = await findStoredCreate(String(user._id), noteApId);
  if (!stored) return res.status(404).json({ error: 'Note not found' });

  const create = isRecord(stored.activity) ? stored.activity : null;
  const oldNote = create && isRecord(create.object) ? create.object : null;
  if (!create || !oldNote) return res.status(409).json({ error: 'Stored ActivityPub note is invalid' });
  if (oldNote.attributedTo !== undefined && oldNote.attributedTo !== actorUrl) {
    return res.status(409).json({ error: 'Stored ActivityPub note ownership is invalid' });
  }
  if (oldNote.type === 'Tombstone') return res.status(204).end();

  const deletedAt = new Date().toISOString();
  const { to, cc } = audiences(oldNote);
  const tombstone = {
    '@context': AP_CONTEXT,
    id: noteApId,
    type: 'Tombstone',
    formerType: 'Note',
    deleted: deletedAt,
  };
  // Keep the original Create row as the stable object owner but scrub content.
  // Existing GET /notes/:id reads this exact object and therefore no longer
  // serves deleted content; a late client sees a Tombstone, not the old Note.
  await Federation.updateActivity({ _id: stored._id }, { $set: { activity: { ...create, object: tombstone } } });

  const deleteActivity = {
    '@context': AP_CONTEXT,
    id: `${actorUrl}/activities/${uuidv4()}`,
    type: 'Delete',
    actor: actorUrl,
    published: deletedAt,
    to,
    cc,
    object: tombstone,
  };
  await Federation.insertActivity({
    _id: uuidv4(),
    actorUserId: user._id,
    type: 'Delete',
    activityId: deleteActivity.id,
    noteId: noteApId,
    activity: deleteActivity,
    publishedAt: Date.now(),
    createdAt: Date.now(),
  });
  const delivery = await fanOutActivityToFollowers(user, deleteActivity);

  return res.json({ ok: true, noteId: noteApId, deleted: deletedAt, delivery });
});

export default router;
module.exports = router;
module.exports.default = router;
