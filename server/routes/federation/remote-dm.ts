// server/routes/federation/remote-dm.ts
// P6 — recipient-scoped ActivityPub direct-message API.
//
// Inbound direct Notes already live in ap_messages. This route makes that
// durable state visible only to its target user and allows replies through the
// same signed, durable federation delivery queue used by the rest of AP.

import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Federation, Users } from '../../db/repositories';
import { authMiddleware, castAuthed } from '../../middleware/auth';
import { deliverApActivity } from './helpers';
import { parseBoundedPositiveIntQuery, parseNonNegativeSafeIntQuery } from '../../lib/queryNumbers';

const router = express.Router();
const AP_CONTEXT = 'https://www.w3.org/ns/activitystreams';
const MAX_DM_LENGTH = 2000;
const MAX_ACTOR_URL = 2048;
const LIST_SCAN_LIMIT = 500;

interface FederatedMessageRow extends Record<string, unknown> {
  _id?: unknown;
  apId?: unknown;
  actorUrl?: unknown;
  targetUserId?: unknown;
  visibility?: unknown;
  content?: unknown;
  published?: unknown;
  createdAt?: unknown;
  deletedAt?: unknown;
}

interface ActivityRow extends Record<string, unknown> {
  _id?: unknown;
  actorUserId?: unknown;
  actorUrl?: unknown;
  activityId?: unknown;
  noteId?: unknown;
  type?: unknown;
  activity?: unknown;
  publishedAt?: unknown;
  createdAt?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function rowTime(row: Record<string, unknown>): number {
  for (const key of ['published', 'publishedAt', 'createdAt']) {
    const raw = row[key];
    const value = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(value) && value >= 0) return Math.trunc(value);
  }
  return 0;
}

function encodeActor(actorUrl: string): string {
  return Buffer.from(actorUrl, 'utf8').toString('base64url');
}

function decodeActor(threadId: string): string | null {
  if (!/^[A-Za-z0-9_-]{1,4096}$/.test(threadId)) return null;
  try {
    const actorUrl = Buffer.from(threadId, 'base64url').toString('utf8');
    if (!actorUrl || actorUrl.length > MAX_ACTOR_URL) return null;
    const url = new URL(actorUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function actorIdentity(actorUrl: string): { username: string; displayName: string } {
  try {
    const url = new URL(actorUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    const leaf = decodeURIComponent(parts.at(-1) || url.hostname).replace(/^@/, '');
    return {
      username: `${leaf}@${url.hostname}`,
      displayName: `@${leaf}@${url.hostname}`,
    };
  } catch {
    return { username: actorUrl, displayName: actorUrl };
  }
}

function directObject(row: ActivityRow): Record<string, unknown> | null {
  if (row.type !== 'Create' || !isRecord(row.activity)) return null;
  const object = isRecord(row.activity.object) ? row.activity.object : null;
  if (!object || object.type !== 'Note') return null;
  const to = Array.isArray(object.to) ? object.to.filter((v): v is string => typeof v === 'string')
    : typeof object.to === 'string' ? [object.to] : [];
  const cc = Array.isArray(object.cc) ? object.cc.filter((v): v is string => typeof v === 'string')
    : typeof object.cc === 'string' ? [object.cc] : [];
  const publicId = 'https://www.w3.org/ns/activitystreams#Public';
  if (to.includes(publicId) || cc.includes(publicId)
      || to.some(v => v.endsWith('/followers')) || cc.some(v => v.endsWith('/followers'))) return null;
  return object;
}

async function latestInbound(userId: string): Promise<FederatedMessageRow[]> {
  let rows = await Federation.apMessagesFind({
    targetUserId: userId,
    visibility: 'direct',
    deletedAt: null,
  }).sort({ published: -1 }).limit(LIST_SCAN_LIMIT);
  if (!Array.isArray(rows)) rows = [];
  return rows as FederatedMessageRow[];
}

async function latestOutbound(userId: string): Promise<ActivityRow[]> {
  let rows = await Federation.apActivitiesFind({ actorUserId: userId, type: 'Create' })
    .sort({ publishedAt: -1 }).limit(LIST_SCAN_LIMIT);
  if (!Array.isArray(rows)) rows = [];
  return (rows as ActivityRow[]).filter(row => typeof row.actorUrl === 'string' && !!directObject(row));
}

function incomingMessage(row: FederatedMessageRow, actorUrl: string) {
  const threadId = encodeActor(actorUrl);
  const identity = actorIdentity(actorUrl);
  return {
    _id: String(row._id || row.apId || `remote:${rowTime(row)}`),
    dmId: `ap:${threadId}`,
    userId: `ap:${threadId}`,
    displayName: identity.displayName,
    content: typeof row.content === 'string' ? row.content : '',
    createdAt: rowTime(row),
    federated: true,
    actorUrl,
    direction: 'in' as const,
  };
}

function outgoingMessage(row: ActivityRow, userId: string, displayName?: string) {
  const actorUrl = String(row.actorUrl || '');
  const threadId = encodeActor(actorUrl);
  const object = directObject(row) || {};
  return {
    _id: String(row._id || row.activityId || `local:${rowTime(row)}`),
    dmId: `ap:${threadId}`,
    userId,
    displayName: displayName || 'You',
    content: typeof object.content === 'string' ? object.content : '',
    createdAt: rowTime(row),
    federated: true,
    actorUrl,
    direction: 'out' as const,
  };
}

/**
 * @openapi
 * /federation/remote-dms:
 *   get:
 *     tags: [Federation]
 *     summary: List ActivityPub direct-message conversations for the authenticated recipient
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Recipient-scoped remote DM conversations }
 *       401: { description: Authentication required }
 * /federation/remote-dms/{threadId}/messages:
 *   get:
 *     tags: [Federation]
 *     summary: Read one recipient-scoped ActivityPub direct-message conversation
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: threadId, required: true, schema: { type: string } }
 *       - { in: query, name: before, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer, minimum: 1, maximum: 100 } }
 *     responses:
 *       200: { description: Direct-message history }
 *       400: { description: Invalid thread id or pagination }
 *       401: { description: Authentication required }
 *   post:
 *     tags: [Federation]
 *     summary: Reply to an ActivityPub direct-message conversation
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: threadId, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content: { type: string, maxLength: 2000 }
 *               clientNonce: { type: string, maxLength: 100 }
 *     responses:
 *       201: { description: Direct Note persisted and queued for signed delivery }
 *       400: { description: Invalid direct message }
 *       401: { description: Authentication required }
 *       404: { description: Conversation has no inbound message for this recipient }
 */

router.get('/remote-dms', authMiddleware, async (req, res) => {
  const userId = String(castAuthed(req).user.id);
  const [inbound, outbound] = await Promise.all([latestInbound(userId), latestOutbound(userId)]);
  const threads = new Map<string, { actorUrl: string; lastMessage: ReturnType<typeof incomingMessage> | ReturnType<typeof outgoingMessage>; latest: number }>();

  for (const row of inbound) {
    if (typeof row.actorUrl !== 'string' || !row.actorUrl) continue;
    const message = incomingMessage(row, row.actorUrl);
    const latest = rowTime(row);
    const current = threads.get(row.actorUrl);
    if (!current || latest > current.latest) threads.set(row.actorUrl, { actorUrl: row.actorUrl, lastMessage: message, latest });
  }
  for (const row of outbound) {
    const actorUrl = String(row.actorUrl || '');
    if (!actorUrl) continue;
    const message = outgoingMessage(row, userId);
    const latest = rowTime(row);
    const current = threads.get(actorUrl);
    if (!current || latest > current.latest) threads.set(actorUrl, { actorUrl, lastMessage: message, latest });
  }

  const result = [...threads.values()]
    .sort((a, b) => b.latest - a.latest)
    .map(({ actorUrl, lastMessage }) => {
      const threadId = encodeActor(actorUrl);
      const identity = actorIdentity(actorUrl);
      return {
        _id: `ap:${threadId}`,
        dmId: `ap:${threadId}`,
        threadId,
        federated: true,
        actorUrl,
        other: { _id: `ap:${threadId}`, username: identity.username, displayName: identity.displayName, avatarUrl: null },
        lastMessage,
        unreadCount: 0,
      };
    });
  return res.json(result);
});

router.get('/remote-dms/:threadId/messages', authMiddleware, async (req, res) => {
  const actorUrl = decodeActor(String(req.params.threadId ?? ''));
  if (!actorUrl) return res.status(400).json({ error: 'Invalid remote DM thread' });
  const userId = String(castAuthed(req).user.id);
  const limit = parseBoundedPositiveIntQuery(req.query.limit, 50, 100);
  const before = parseNonNegativeSafeIntQuery(req.query.before, Date.now() + 1);
  if (limit === null || before === null) return res.status(400).json({ error: 'Invalid pagination' });

  let inbound = await Federation.apMessagesFind({
    targetUserId: userId,
    visibility: 'direct',
    actorUrl,
    deletedAt: null,
  }).sort({ published: -1 }).limit(Math.min(LIST_SCAN_LIMIT, limit * 3));
  if (!Array.isArray(inbound)) inbound = [];
  let outbound = await Federation.apActivitiesFind({ actorUserId: userId, actorUrl, type: 'Create' })
    .sort({ publishedAt: -1 }).limit(Math.min(LIST_SCAN_LIMIT, limit * 3));
  if (!Array.isArray(outbound)) outbound = [];

  const me = await Users.findById(userId);
  const merged = [
    ...(inbound as FederatedMessageRow[]).map(row => incomingMessage(row, actorUrl)),
    ...(outbound as ActivityRow[]).filter(row => !!directObject(row)).map(row => outgoingMessage(row, userId, me?.displayName || me?.username)),
  ]
    .filter(message => Number(message.createdAt) < before)
    .sort((a, b) => Number(a.createdAt) - Number(b.createdAt));

  return res.json(merged.slice(Math.max(0, merged.length - limit)));
});

router.post('/remote-dms/:threadId/messages', authMiddleware, express.json(), async (req, res) => {
  const actorUrl = decodeActor(String(req.params.threadId ?? ''));
  if (!actorUrl) return res.status(400).json({ error: 'Invalid remote DM thread' });
  const userId = String(castAuthed(req).user.id);
  const body = isRecord(req.body) ? req.body : {};
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!content || content.length > MAX_DM_LENGTH) {
    return res.status(400).json({ error: `content must be 1..${MAX_DM_LENGTH} characters` });
  }
  const clientNonce = body.clientNonce === undefined ? '' : String(body.clientNonce);
  if (clientNonce && !/^[A-Za-z0-9:_-]{1,100}$/.test(clientNonce)) {
    return res.status(400).json({ error: 'Invalid client nonce' });
  }

  // A thread is not an arbitrary SSRF/delivery surface: the recipient must
  // already have a durable inbound direct Note from this actor.
  const existingInbound = await Federation.findApMessageOne({
    targetUserId: userId,
    visibility: 'direct',
    actorUrl,
  });
  if (!existingInbound) return res.status(404).json({ error: 'Remote DM conversation not found' });

  const user = await Users.findById(userId);
  if (!user) return res.status(401).json({ error: 'Authentication user not found' });
  const localActor = `${process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`}/api/federation/users/${user.username}`;
  const activitySuffix = clientNonce ? `dm-${clientNonce}` : uuidv4();
  const activityId = `${localActor}/activities/${activitySuffix}`;

  // Retry-safe at the local journal boundary. A transport retry carrying the
  // same client nonce reuses the same ActivityPub activity id.
  const existingRows = await Federation.findActivities({ actorUserId: userId, activityId });
  if (Array.isArray(existingRows) && existingRows[0]) {
    return res.status(200).json(outgoingMessage(existingRows[0] as ActivityRow, userId, user.displayName || user.username));
  }

  const now = Date.now();
  const published = new Date(now).toISOString();
  const noteId = `${localActor}/notes/${uuidv4()}`;
  const activity = {
    '@context': AP_CONTEXT,
    id: activityId,
    type: 'Create',
    actor: localActor,
    published,
    to: [actorUrl],
    cc: [],
    object: {
      '@context': AP_CONTEXT,
      id: noteId,
      type: 'Note',
      attributedTo: localActor,
      content,
      published,
      to: [actorUrl],
      cc: [],
    },
  };
  const row: ActivityRow = {
    _id: uuidv4(),
    actorUserId: userId,
    actorUrl,
    type: 'Create',
    activityId,
    noteId,
    activity,
    publishedAt: now,
    createdAt: now,
  };
  await Federation.insertActivity(row);
  await deliverApActivity(actorUrl, activity, user);

  return res.status(201).json(outgoingMessage(row, userId, user.displayName || user.username));
});

export default router;
module.exports = router;
module.exports.default = router;
