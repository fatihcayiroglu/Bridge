// server/routes/messages.ts
import express, { Request, Response, Router } from 'express';
import { authMiddleware} from '../middleware/auth';

import { Messages, Channels, Members } from '../db/repositories';
import { limits } from '../middleware/rateLimit';
import { validateBody, schemas } from '../middleware/validate';
import { cache } from '../lib/redisAdapter';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
// Sprint 120: T5 — Server-side DOMPurify sanitization
import { sanitizeMessageContent } from '../lib/contentSanitizer';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { clearUnread } from '../lib/notifications';
import { getMemberPerms, hasPermission as hp, PERMS as P } from './roles';

interface MsgRow {
  _id: string;
  channelId: string;
  serverId: string;
  userId: string;
  content?: string;
  type?: string;
  reactions?: Record<string, string[]>;
  editHistory?: { content: string; editedAt: number }[];
  editedAt?: number;
  createdAt: number;
}

interface CursorData { ts: number; id: string; dir: 'before' | 'after' }

async function requireChannelMembership(userId: string, channelId: string, res: Response) {
  const cacheKey = `channel:${channelId}`;
  let channel = await cache.get(cacheKey) as { _id: string; serverId: string } | null;
  if (!channel) {
    channel = await Channels.findById(channelId);
    if (channel) await cache.set(cacheKey, channel, 60);
  }
  if (!channel) { res.status(404).json({ error: 'Channel not found' }); return null; }
  const membership = await Members.findOne(userId, channel.serverId);
  if (!membership) { res.status(403).json({ error: 'Not a member' }); return null; }
  return channel;
}

const router: Router = express.Router();

// GET /api/channels/:cid/messages
/**
 * @openapi
 * /channels/{channelId}/messages:
 *   get:
 *     tags: [Messages]
 *     summary: Kanal mesajlarını listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: channelId, in: path, required: true, schema: { type: string } }
 *       - { name: before, in: query, schema: { type: string }, description: Cursor pagination }
 *       - { name: limit, in: query, schema: { type: integer, default: 50, maximum: 100 } }
 *     responses:
 *       200:
 *         description: Mesaj listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Message' }
 * /{messageId}:
 *   patch:
 *     tags: [Messages]
 *     summary: Mesajı düzenle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: messageId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content: { type: string, maxLength: 4000 }
 *     responses:
 *       200:
 *         description: Güncellendi
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Message' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Messages]
 *     summary: Mesajı sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: messageId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       204: { description: Silindi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 * /{messageId}/react:
 *   post:
 *     tags: [Messages]
 *     summary: Mesaja emoji tepkisi ekle / kaldır
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: messageId, in: path, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [emoji]
 *             properties:
 *               emoji: { type: string, example: "👍" }
 *     responses:
 *       200: { description: Tepki güncellendi }
 */
/**
 * @openapi
 * /channels/{cid}/messages:
 *   get:
 *     tags: [Messages]
 *     summary: Kanal mesajlarını listele
 *     parameters:
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *         description: Kanal ID
 *       - in: query
 *         name: before
 *         schema: { type: string }
 *         description: Cursor — bu mesaj ID'sinden öncekiler
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 100 }
 *     responses:
 *       200:
 *         description: Mesaj listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Message' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/:cid/messages', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const channel = await requireChannelMembership(_u.id, String(req.params.cid ?? ''), res);
  if (!channel) return;

  const perms = await resolvePermissions(_u.id, channel.serverId, String(req.params.cid ?? ''));
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS))
    return void res.status(403).json({ error: 'No permission to view this channel' });
  if (!hasPermission(perms, PERMS.READ_HISTORY))
    return void res.status(403).json({ error: 'No permission to read message history' });

  const limit = Math.min(parseInt(String(req.query.limit ?? '')) || 50, 100);

  let cursorData: CursorData | null = null;
  if (typeof req.query.cursor === 'string' && req.query.cursor.length > 0) {
    try {
      cursorData = JSON.parse(Buffer.from(req.query.cursor, 'base64').toString('utf8')) as CursorData;
    } catch {
      return void res.status(400).json({ error: 'Invalid cursor' });
    }
  }

  const legacyBefore = typeof req.query.before === 'string' ? parseInt(req.query.before) : undefined;
  const legacyAfter  = typeof req.query.after === 'string' ? parseInt(req.query.after) : undefined;
  const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 100) : undefined;
  const isFirstPage  = !req.query.cursor && !legacyBefore && !legacyAfter && !searchQuery;
  const cacheKey     = `messages:${String(req.params.cid ?? '')}:first:${limit}`;

  if (isFirstPage) {
    const cached = await cache.get(cacheKey);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      clearUnread(_u.id, String(req.params.cid ?? '')).catch(() => {});
      return void res.json(cached);
    }
  }

  const raw     = await Messages.findByChannel(String(req.params.cid ?? ''), {
    limit: limit + 1,
    before: cursorData?.ts || legacyBefore,
    after:  cursorData?.dir === 'after' ? cursorData?.ts : legacyAfter,
    search: searchQuery,
  });
  const hasMore = raw.length > limit;
  const page    = hasMore ? raw.slice(0, limit) : raw;
  if (!cursorData || cursorData.dir !== 'after') page.reverse();

  let nextCursor: string | null = null;
  let prevCursor: string | null = null;
  if (page.length > 0) {
    const oldest = page[0];
    const newest = page[page.length - 1];
    prevCursor = Buffer.from(JSON.stringify({ ts: oldest.createdAt, id: oldest._id, dir: 'before' })).toString('base64');
    if (hasMore || cursorData?.dir === 'after') {
      nextCursor = Buffer.from(JSON.stringify({ ts: newest.createdAt, id: newest._id, dir: 'after' })).toString('base64');
    }
  }

  const response = { messages: page, hasMore, nextCursor, prevCursor, limit, count: page.length };

  // Adaptive TTL: aktif kanallar (son mesaj < 2dk) 5s; ılımlı aktif (< 10dk) 15s; sessiz 45s.
  // 10s sabit TTL Roadmap'teki "Mesaj cache TTL optimizasyonu" maddesini karşılıyordu ama
  // aktif kanallarda bayat veri, sessiz kanallarda gereksiz DB hit'i yaratıyordu.
  if (isFirstPage && !searchQuery) {
    const newestMsg = page[page.length - 1];
    const ageMs     = newestMsg ? (Date.now() - newestMsg.createdAt) : Infinity;
    const ttl = ageMs < 2 * 60_000  ? 5   // çok aktif kanal   → 5s
               : ageMs < 10 * 60_000 ? 15  // orta aktif kanal  → 15s
               : 45;                        // sessiz kanal      → 45s
    await cache.set(cacheKey, response, ttl);
  }
  clearUnread(_u.id, String(req.params.cid ?? '')).catch(() => {});
  res.setHeader('X-Cache', 'MISS');
  res.json(response);
});

// GET /api/channels/:cid/pinned
/**
 * @openapi
 * /channels/{cid}/pinned:
 *   get:
 *     tags: [Messages]
 *     summary: Sabitlenmiş mesajlar
 *     parameters:
 *       - in: path
 *         name: cid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Sabitlenmiş mesaj listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Message' }
 */
router.get('/:cid/pinned', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const channel = await requireChannelMembership(_u.id, String(req.params.cid ?? ''), res);
  if (!channel) return;
  res.json(await Messages.findPinned(String(req.params.cid ?? '')));
});

// DELETE /api/messages/:id
/**
 * @openapi
 * /messages/{id}:
 *   delete:
 *     tags: [Messages]
 *     summary: Mesajı sil
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Mesaj silindi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.delete('/:id', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const msg = await Messages.findById(String(req.params.id ?? ''));
  if (!msg) return void res.status(404).json({ error: 'Message not found' });

  const membership = await Members.findOne(_u.id, msg.serverId);
  if (!membership) return void res.status(403).json({ error: 'Not a member of this server' });

  const perms     = await getMemberPerms(_u.id, msg.serverId);
  const canDelete = msg.userId === _u.id || hp(perms, P.MANAGE_MESSAGES);
  if (!canDelete) return void res.status(403).json({ error: 'Not your message' });

  // Sprint 121 FIX 17: Soft delete — içerik '[Mesaj silindi]' olur, DB kaydı korunur
  await Messages.softDelete(String(req.params.id ?? ''), _u.id);
  res.json({ deleted: true, id: String(req.params.id ?? '') });
});

// DELETE /api/messages/bulk — Sprint 121 FIX 18: Toplu mesaj silme (moderasyon)
/**
 * @openapi
 * /messages/bulk:
 *   delete:
 *     tags: [Messages]
 *     summary: Toplu mesaj sil (moderatör)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids]
 *             properties:
 *               ids: { type: array, items: { type: string }, maxItems: 100 }
 *     responses:
 *       200: { description: Silinen mesaj sayısı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.delete('/bulk', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { ids, serverId } = req.body as { ids?: unknown; serverId?: string };

  if (!Array.isArray(ids) || ids.length === 0) {
    return void res.status(400).json({ error: 'ids must be a non-empty array' });
  }
  if (ids.length > 100) {
    return void res.status(400).json({ error: 'Maximum 100 messages per bulk delete' });
  }
  if (!serverId || typeof serverId !== 'string') {
    return void res.status(400).json({ error: 'serverId required' });
  }

  const { getMemberPerms, hasPermission: hp, PERMS: P } = await import('./roles');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hp(perms, P.MANAGE_MESSAGES) && !hp(perms, P.ADMINISTRATOR)) {
    return void res.status(403).json({ error: 'MANAGE_MESSAGES permission required for bulk delete' });
  }

  const safeIds = (ids as unknown[]).filter((id): id is string => typeof id === 'string').slice(0, 100);
  const count = await Messages.bulkSoftDelete(safeIds, _u.id);
  res.json({ deleted: count });
});

// PATCH /api/messages/:id
/**
 * @openapi
 * /messages/{id}:
 *   patch:
 *     tags: [Messages]
 *     summary: Mesajı düzenle
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               content: { type: string }
 *     responses:
 *       200:
 *         description: Düzenlenmiş mesaj
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Message' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.patch('/:id', authMiddleware, limits.messages(), validateBody(schemas['message']),
  async (req: Request, res: Response) => {
    const _u = castAuthed(req).user;
    const msg = await Messages.findById(String(req.params.id ?? ''));
    if (!msg) return void res.status(404).json({ error: 'Message not found' });
    if (msg.userId !== _u.id) return void res.status(403).json({ error: 'Not your message' });
    if (msg.type !== 'normal') return void res.status(400).json({ error: 'Cannot edit this message type' });

    const history = Array.isArray(msg.editHistory) ? msg.editHistory : [];
    history.push({ content: msg.content ?? '', editedAt: msg.editedAt || msg.createdAt });

    await Messages.update(String(req.params.id ?? ''), {
      content: sanitizeMessageContent((req.body as { content: string }).content),
      editedAt: Date.now(),
      editHistory: history.slice(-10),
    });
    res.json(await Messages.findById(String(req.params.id ?? '')));
  }
);

// GET /api/messages/:id/history
/**
 * @openapi
 * /messages/{id}/history:
 *   get:
 *     tags: [Messages]
 *     summary: Mesaj düzenleme geçmişi
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Düzenleme geçmişi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: object }
 */
router.get('/:id/history', authMiddleware, async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const msg = await Messages.findById(String(req.params.id ?? ''));
  if (!msg) return void res.status(404).json({ error: 'Message not found' });
  const channel = await requireChannelMembership(_u.id, msg.channelId, res);
  if (!channel) return;
  res.json({ editHistory: Array.isArray(msg.editHistory) ? msg.editHistory : [], current: { content: msg.content, editedAt: msg.editedAt } });
});

// POST /api/messages/:id/react
/**
 * @openapi
 * /messages/{id}/react:
 *   post:
 *     tags: [Messages]
 *     summary: Mesaja tepki ekle/kaldır
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [emoji]
 *             properties:
 *               emoji: { type: string, example: '👍' }
 *     responses:
 *       200: { description: Tepki güncellendi }
 */
router.post('/:id/react', authMiddleware, limits.react(), async (req: Request, res: Response) => {
  const _u = castAuthed(req).user;
  const { emoji } = req.body as { emoji?: string };
  if (!emoji || typeof emoji !== 'string' || emoji.length > 12)
    return void res.status(400).json({ error: 'Invalid emoji' });

  const msg = await Messages.findById(String(req.params.id ?? ''));
  if (!msg) return void res.status(404).json({ error: 'Message not found' });

  const membership = await Members.findOne(_u.id, msg.serverId);
  if (!membership) return void res.status(403).json({ error: 'Not a member' });

  const reactions: Record<string, string[]> = (msg.reactions ?? {}) as Record<string, string[]>;
  if (!reactions[emoji] && Object.keys(reactions).length >= 20)
    return void res.status(400).json({ error: 'Max 20 unique reactions per message' });

  const users = reactions[emoji] || [];
  const idx   = users.indexOf(_u.id);
  if (idx === -1) users.push(_u.id); else users.splice(idx, 1);
  if (users.length === 0) delete reactions[emoji]; else reactions[emoji] = users;

  await Messages.update(String(req.params.id ?? ''), { reactions });
  res.json(await Messages.findById(String(req.params.id ?? '')));
});

 
export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
