// P6 — user-facing remote ActivityPub direct messages.
//
// Inbound remote direct Notes are already persisted in ap_messages with
// visibility='direct' + targetUserId. This router makes that private state
// readable only by its recipient and provides a durable outbound direct Note
// path using the existing signed delivery queue.

import express from 'express';
import { generateKeyPairSync } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { Federation, Users } from '../../db/repositories';
import { authMiddleware, castAuthed } from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import { parseBoundedPositiveIntQuery } from '../../lib/queryNumbers';
import { deliverApActivity, resolveFollowTarget } from './delivery';

const router = express.Router();
const AP_CONTEXT = 'https://www.w3.org/ns/activitystreams';

function parseFederatedHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 2048) return null;
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    parsed.hash = '';
    return parsed.href;
  } catch {
    return null;
  }
}

async function ensureApKeys(user: Record<string, unknown>): Promise<void> {
  if (user.apPublicKey) return;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  await Users.saveApKeys(String(user._id), publicKey, privateKey);
  user.apPublicKey = publicKey;
}

/**
 * @openapi
 * /federation/remote-dms:
 *   get:
 *     tags: [Federation]
 *     summary: List the authenticated user's live remote ActivityPub direct messages
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100, default: 50 }
 *     responses:
 *       200:
 *         description: Recipient-scoped direct-message page
 *       400:
 *         description: Invalid pagination
 *       401:
 *         description: Authentication required
 *   post:
 *     tags: [Federation]
 *     summary: Send a durable ActivityPub direct Note to a remote actor
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [actorUrl, content]
 *             properties:
 *               actorUrl: { type: string, format: uri, maxLength: 2048 }
 *               content: { type: string, minLength: 1, maxLength: 5000 }
 *     responses:
 *       202:
 *         description: Activity persisted and handed to durable federation delivery
 *       400:
 *         description: Invalid target or content
 *       401:
 *         description: Authentication required
 *       403:
 *         description: Federation target blocked by policy
 *       409:
 *         description: Local federated identity unavailable
 */
router.get('/remote-dms', authMiddleware, async (req, res) => {
  const userId = String(castAuthed(req).user.id);
  const page = parseBoundedPositiveIntQuery(req.query.page, 1, 1_000_000);
  const limit = parseBoundedPositiveIntQuery(req.query.limit, 50, 100);
  if (page === null || limit === null) {
    return res.status(400).json({ error: 'page/limit must be positive safe integers' });
  }
  const skip = (page - 1) * limit;
  const query = {
    targetUserId: userId,
    visibility: 'direct',
    deletedAt: null,
  };

  let rows = await Federation.apMessagesFind(query)
    .sort({ published: -1, createdAt: -1 })
    .skip(skip)
    .limit(limit) || [];
  if (!Array.isArray(rows)) rows = await rows || [];
  const total = await Federation.countApMessages(query);

  const items = rows.map((row: Record<string, unknown>) => ({
    id: row._id,
    apId: row.apId,
    actorUrl: row.actorUrl,
    content: row.content,
    summary: row.summary ?? null,
    sensitive: row.sensitive === true,
    attachments: Array.isArray(row.attachments) ? row.attachments : [],
    published: row.published ?? row.createdAt,
    updatedAt: row.updatedAt ?? null,
  }));

  return res.json({
    items,
    total: Number(total || 0),
    page,
    limit,
    pages: Math.ceil(Number(total || 0) / limit),
  });
});

router.post('/remote-dms', authMiddleware, limits.federation(), async (req, res) => {
  const userId = String(castAuthed(req).user.id);
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown>
    : {};
  const actorUrl = parseFederatedHttpUrl(body.actorUrl);
  const content = typeof body.content === 'string' ? body.content.trim() : '';
  if (!actorUrl) return res.status(400).json({ error: 'actorUrl must be a valid http(s) URL' });
  if (!content) return res.status(400).json({ error: 'content is required' });
  if (content.length > 5000) return res.status(400).json({ error: 'content exceeds maximum length of 5000 characters' });

  const user = await Users.findById(userId) as Record<string, unknown> | null;
  if (!user) return res.status(401).json({ error: 'Not found' });
  await ensureApKeys(user);

  // Reuse the P5 SSRF + outbound ACL actor validation before persisting a
  // delivery intent. Invalid/private/blocked targets never enter the queue.
  const target = await resolveFollowTarget(actorUrl);
  if (!target.ok) return res.status(target.status).json({ error: target.error });

  const username = String(user.username || '');
  if (!username) return res.status(409).json({ error: 'Federated identity is unavailable' });
  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const localActor = `${instanceUrl}/api/federation/users/${username}`;
  const now = Date.now();
  const published = new Date(now).toISOString();
  const noteId = `${localActor}/notes/${uuidv4()}`;
  const createId = `${localActor}/activities/${uuidv4()}`;

  const note = {
    '@context': AP_CONTEXT,
    id: noteId,
    type: 'Note',
    attributedTo: localActor,
    content,
    published,
    to: [actorUrl],
    cc: [],
  };
  const create = {
    '@context': AP_CONTEXT,
    id: createId,
    type: 'Create',
    actor: localActor,
    published,
    to: [actorUrl],
    cc: [],
    object: note,
  };

  // Persist the authored activity before queueing delivery. The delivery
  // function itself persists its queue row before the first network attempt.
  await Federation.insertActivity({
    _id: uuidv4(),
    actorUserId: userId,
    type: 'Create',
    activityId: createId,
    noteId,
    activity: create,
    publishedAt: now,
    createdAt: now,
  });
  await deliverApActivity(actorUrl, create, user as never);

  return res.status(202).json({ ok: true, id: createId, noteId, actorUrl, published });
});

export default router;
module.exports = router;
module.exports.default = router;