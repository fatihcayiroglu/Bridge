// server/routes/threads.ts (v17 + forum extensions)
// Thread system + Forum kanalı: oluşturma, liste, pin, lock, tags
import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
import { parseBoundedPositiveIntQuery, parseNonNegativeSafeIntQuery } from '../lib/queryNumbers';
const router       = express.Router();
import { Threads, Members, Channels, Users, Messages } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { hasPermission, PERMS, resolvePermissions } from './roles';
import { limits } from '../middleware/rateLimit';
import { processNotifications } from '../lib/notifications';
import logger from '../lib/logger';
import { isMemberTimedOut, parseMemberTimeoutUntil } from '../lib/memberTimeout';

// ── helpers ────────────────────────────────────────────────────
async function memberCheck(userId: string, serverId: string) {
  return Members.findOne(userId, serverId);
}

async function channelPermissions(userId: string, serverId: string, channelId: string): Promise<number> {
  return resolvePermissions(userId, serverId, channelId).catch(() => 0);
}

async function canReadThread(userId: string, thread: { serverId: string; channelId: string }): Promise<boolean> {
  const perms = await channelPermissions(userId, thread.serverId, thread.channelId);
  return hasPermission(perms, PERMS.VIEW_CHANNELS) && hasPermission(perms, PERMS.READ_HISTORY);
}

// ── Forum: POST /api/threads — forum kanalında yeni ileti VEYA mesajdan thread
/**
 * @openapi
 * /threads:
 *   post:
 *     tags: [Threads]
 *     summary: Thread oluştur
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, channelId]
 *             properties:
 *               title: { type: string }
 *               channelId: { type: string, format: uuid }
 *               content: { type: string }
 *     responses:
 *       201:
 *         description: Thread oluşturuldu
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Thread' }
 */
router.post('/', authMiddleware, limits.messages(), async (req, res) => {
  const _u = castAuthed(req).user;
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? req.body as Record<string, unknown> : {};
  const parentMessageId = body.parentMessageId;
  const name = body.name;
  const channelId = body.channelId;
  const firstMessage = body.firstMessage;
  const rawTags = body.tags ?? [];
  if (parentMessageId !== undefined && (typeof parentMessageId !== 'string' || !parentMessageId.trim() || parentMessageId.length > 128))
    return res.status(400).json({ error: 'parentMessageId invalid' });
  if (channelId !== undefined && (typeof channelId !== 'string' || !channelId.trim() || channelId.length > 128))
    return res.status(400).json({ error: 'channelId invalid' });
  if (name !== undefined && typeof name !== 'string')
    return res.status(400).json({ error: 'name invalid' });
  if (firstMessage !== undefined && (typeof firstMessage !== 'string' || firstMessage.length > 2000))
    return res.status(400).json({ error: 'firstMessage invalid' });
  if (rawTags !== undefined && (!Array.isArray(rawTags) || rawTags.some(t => typeof t !== 'string')))
    return res.status(400).json({ error: 'tags must be a string array' });
  if (parentMessageId && channelId) return res.status(400).json({ error: 'Choose parentMessageId or channelId, not both' });
  const tags = rawTags as string[];

  // ── Forum channel thread (channelId + name) ───────────────────
  if (channelId && !parentMessageId) {
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });

    const channel = await Channels.findById(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (channel.type !== 'forum') return res.status(400).json({ error: 'Not a forum channel' });

    const member = await memberCheck(_u.id, channel.serverId);
    if (!member) return res.status(403).json({ error: 'Not a member' });
    if (isMemberTimedOut(member.timeoutUntil))
      return res.status(403).json({ error: 'You are timed out', until: parseMemberTimeoutUntil(member.timeoutUntil) });

    const perms = await channelPermissions(_u.id, channel.serverId, channelId);
    if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.SEND_MESSAGES)) return res.status(403).json({ error: 'No permission' });

    const user = await Users.findById(_u.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const now  = Date.now();

    const thread = await Threads.insert({
      channelId,
      serverId:         channel.serverId,
      parentMessageId:  null,
      name:             name.trim().slice(0, 100),
      firstMessage:     (firstMessage || '').slice(0, 500),
      tags:             JSON.stringify(tags.slice(0, 5).map(t => t.slice(0, 20))),
      createdBy:        _u.id,
      createdAt:        now,
      lastMessageAt:    now,
      messageCount:     firstMessage?.trim() ? 1 : 0,
      participantCount: 1,
      pinned:           false,
      locked:           false,
    });

    // ilk mesajı thread içine ekle
    if (firstMessage?.trim()) {
      await Threads.insertMessage({
        threadId:    thread._id,
        channelId,
        serverId:    channel.serverId,
        userId:      _u.id,
        username:    user.username,
        displayName: user.displayName,
        avatarColor: user.avatarColor || '#2d9cdb',
        content:     firstMessage.trim(),
        type:        'normal',
        reactions:   {},
        createdAt:   now,
      });
    }

    const io = req.app.get('io');
    if (io) io.to(`channel:${channelId}`).emit('forum:thread:created', thread);

    return res.status(201).json({ thread });
  }

  // ── Normal message thread ──────────────────────────────────────
  if (!parentMessageId) return res.status(400).json({ error: 'parentMessageId required' });

  const parent = await Messages.findById(parentMessageId);
  if (!parent) return res.status(404).json({ error: 'Message not found' });

  const member = await memberCheck(_u.id, parent.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const parentPerms = await channelPermissions(_u.id, parent.serverId, parent.channelId);
  if (!hasPermission(parentPerms, PERMS.VIEW_CHANNELS) ||
      !hasPermission(parentPerms, PERMS.READ_HISTORY) ||
      !hasPermission(parentPerms, PERMS.SEND_MESSAGES)) {
    return res.status(403).json({ error: 'No permission' });
  }

  const threadName = (name?.trim() || parent.content?.slice(0, 50) || 'Thread').slice(0, 100);
  const result = await Threads.createForParentAtomic({
    channelId:       parent.channelId,
    serverId:        parent.serverId,
    parentMessageId,
    name:            threadName,
    createdBy:       _u.id,
    createdAt:       Date.now(),
    lastMessageAt:   Date.now(),
    messageCount:    0,
  });
  if (!result.created) return res.status(409).json({ error: 'Thread already exists', thread: result.thread });

  res.json(result.thread);
});

// GET /api/threads/:threadId — thread info
/**
 * @openapi
 * /threads/{threadId}:
 *   get:
 *     tags: [Threads]
 *     summary: Thread detayı
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Thread
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Thread' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get('/:threadId', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const thread = await Threads.findById(String(req.params.threadId ?? ''));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const member = await memberCheck(_u.id, thread.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  if (!await canReadThread(_u.id, thread)) return res.status(403).json({ error: 'No permission' });
  res.json(thread);
});

// GET /api/threads/:threadId/messages — paginated thread messages
/**
 * @openapi
 * /threads/{threadId}/messages:
 *   get:
 *     tags: [Threads]
 *     summary: Thread mesajları
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: before
 *         schema: { type: string }
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
 */
router.get('/:threadId/messages', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const thread = await Threads.findById(String(req.params.threadId ?? ''));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const member = await memberCheck(_u.id, thread.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  if (!await canReadThread(_u.id, thread)) return res.status(403).json({ error: 'No permission' });

  const limit  = parseBoundedPositiveIntQuery(req.query.limit, 50, 100);
  const before = parseNonNegativeSafeIntQuery(req.query.before, Date.now() + 1);
  if (limit === null || before === null) {
    return res.status(400).json({ error: 'limit/before must be safe non-negative integers (limit >= 1)' });
  }

  const msgs = await Threads.findMessages(String(req.params.threadId ?? ''), { limit, before });
  res.json(msgs.reverse());
});

// POST /api/threads/:threadId/messages — send a message to a thread
/**
 * @openapi
 * /threads/{threadId}/messages:
 *   post:
 *     tags: [Threads]
 *     summary: Thread'e mesaj gönder
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [content]
 *             properties:
 *               content: { type: string }
 *     responses:
 *       201:
 *         description: Mesaj gönderildi
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Message' }
 */
router.post('/:threadId/messages', authMiddleware, limits.messages(), async (req, res) => {
  const _u = castAuthed(req).user;
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? req.body as Record<string, unknown> : {};
  const content = body.content;
  const clientNonce = body.clientNonce;
  if (typeof content !== 'string' || !content.trim()) return res.status(400).json({ error: 'content required' });
  if (content.length > 2000) return res.status(400).json({ error: 'Message too long' });
  if (clientNonce !== undefined && (typeof clientNonce !== 'string' || clientNonce.length < 8 || clientNonce.length > 128))
    return res.status(400).json({ error: 'clientNonce invalid' });

  const thread = await Threads.findById(String(req.params.threadId ?? ''));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  const member = await memberCheck(_u.id, thread.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  if (thread.locked) return res.status(423).json({ error: 'Thread is locked' });

  // timeout check
  if (isMemberTimedOut(member.timeoutUntil)) {
    return res.status(403).json({ error: 'You are timed out', until: parseMemberTimeoutUntil(member.timeoutUntil) });
  }

  const perms = await channelPermissions(_u.id, thread.serverId, thread.channelId);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.READ_HISTORY) || !hasPermission(perms, PERMS.SEND_MESSAGES)) return res.status(403).json({ error: 'No permission' });

  const user = await Users.findById(_u.id);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const inserted = await Threads.insertMessageIdempotent({
    threadId:    thread._id,
    channelId:   thread.channelId,
    serverId:    thread.serverId,
    userId:      _u.id,
    username:    user.username,
    displayName: user.displayName,
    avatarColor: user.avatarColor,
    content:     content.trim(),
    clientNonce: typeof clientNonce === 'string' ? clientNonce : null,
    type:        'normal',
    reactions:   {},
    createdAt:   Date.now(),
  });
  const msg = inserted.message;

  // Retry after a lost HTTP response returns the canonical row and MUST NOT
  // increment counters or emit notifications a second time.
  if (!inserted.created) return res.status(200).json(msg);

  await Threads.recordReply(thread._id, thread.parentMessageId);

  // Persistence is complete; the server is the sole realtime authority.
  const threadIo = req.app.get('io');
  if (threadIo) threadIo.to(`thread:${thread._id}`).emit('thread:message:new', { threadId: thread._id, msg });

  // Notify thread participants (mention detection + thread reply notification)
  const io          = req.app.get('io');
  const socketUsers = req.app.get('socketUsers') ?? new Map();
  if (io) {
    // Collect unique participants: anyone who previously posted in this thread
    const prevMessages = await Threads.listAllMessages(thread._id);
    const participantIds = [...new Set(
      prevMessages
        .map(m => m.userId)
        .filter(uid => uid !== _u.id) // don't notify the sender
    )];

    // Also notify the thread creator if different from sender
    if (thread.createdBy && thread.createdBy !== _u.id && !participantIds.includes(thread.createdBy)) {
      participantIds.push(thread.createdBy);
    }

    // Send only to participants who can STILL read the parent channel. A
    // historical post is not a permanent entitlement after permission removal.
    for (const uid of participantIds) {
      if (!await canReadThread(uid, thread)) continue;
      io.to(`user:${uid}`).emit('notification:thread_reply', {
        type:        'thread_reply',
        threadId:    thread._id,
        threadName:  thread.name,
        channelId:   thread.channelId,
        serverId:    thread.serverId,
        messageId:   msg._id,
        fromUser:    user.displayName,
        fromUserId:  _u.id,
        preview:     content.trim().slice(0, 100),
        createdAt:   msg.createdAt,
      });
    }

    // Standard mention notifications (handles @username in thread messages)
    await processNotifications(
      { ...msg, channelId: msg.channelId ?? thread.channelId, serverId: msg.serverId ?? thread.serverId, userId: _u.id, displayName: user.displayName },
      io,
      socketUsers
    ).catch((err: unknown) => {
      logger.warn({ event: 'thread_notification_pipeline_failed', threadId: thread._id,
        messageId: msg._id, err: err instanceof Error ? err.message : String(err) },
      'Thread message persisted but notification pipeline failed');
    });
  }

  res.json(msg);
});

// GET /api/threads/channel/:channelId — list threads in a channel (forum aware)
/**
 * @openapi
 * /threads/channel/{channelId}:
 *   get:
 *     tags: [Threads]
 *     summary: Kanaldaki thread'leri listele
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Thread listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/Thread' }
 */
router.get('/channel/:channelId', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await Channels.findById(String(req.params.channelId ?? ''));
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const member = await memberCheck(_u.id, channel.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const perms = await channelPermissions(_u.id, channel.serverId, String(req.params.channelId ?? ''));
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.READ_HISTORY))
    return res.status(403).json({ error: 'No permission' });

  const sort = String(req.query.sort ?? 'latest');
  const tag = typeof req.query.tag === 'string' ? req.query.tag : '';
  const search = typeof req.query.search === 'string' ? req.query.search : '';
  let threads = await Threads.findByChannel(String(req.params.channelId ?? ''));

  // filter
  if (tag)    threads = threads.filter(t => { try { return JSON.parse(String(t.tags || '[]')).includes(tag); } catch { return false; } });
  if (search) threads = threads.filter(t => String(t.name ?? '').toLowerCase().includes(search.toLowerCase()));

  // sort
  if (sort === 'top')     threads.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
  else if (sort === 'new') threads.sort((a, b) => b.createdAt - a.createdAt);
  else                     threads.sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));

  // pinned first
  threads.sort((a, b) => (b.pinned || 0) - (a.pinned || 0));

  res.setHeader('X-Bridge-Forum-Can-Manage', hasPermission(perms, PERMS.MANAGE_MESSAGES) ? '1' : '0');

  // parse tags JSON
  threads = threads.slice(0, 100).map(t => ({
    ...t,
    tags: (() => { try { return JSON.parse(String(t.tags || '[]')); } catch { return []; } })(),
  }));

  res.json(threads);
});

// PATCH /api/threads/:threadId/pin — pin/unpin (mod only)
/**
 * @openapi
 * /threads/{threadId}/pin:
 *   patch:
 *     tags: [Threads]
 *     summary: Thread'i sabitle / sabitlemeden kaldır
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Sabitleme durumu güncellendi }
 */
router.patch('/:threadId/pin', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const thread = await Threads.findById(String(req.params.threadId ?? ''));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const perms = await channelPermissions(_u.id, thread.serverId, thread.channelId);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.MANAGE_MESSAGES)) return res.status(403).json({ error: 'No permission' });

  if (typeof req.body?.pinned !== 'boolean') return res.status(400).json({ error: 'pinned must be boolean' });
  const pinned = req.body.pinned ? 1 : 0;
  await Threads.setPinned(String(req.params.threadId ?? ''), req.body.pinned);
  const io = req.app.get('io');
  if (io) io.to(`channel:${thread.channelId}`).emit('forum:thread:updated', { threadId: thread._id, pinned });
  res.json({ ok: true, pinned });
});

// PATCH /api/threads/:threadId/lock — lock/unlock (mod only)
/**
 * @openapi
 * /threads/{threadId}/lock:
 *   patch:
 *     tags: [Threads]
 *     summary: Thread'i kilitle / kilidini kaldır
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Kilit durumu güncellendi }
 */
router.patch('/:threadId/lock', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const thread = await Threads.findById(String(req.params.threadId ?? ''));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const perms = await channelPermissions(_u.id, thread.serverId, thread.channelId);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.MANAGE_MESSAGES)) return res.status(403).json({ error: 'No permission' });

  if (typeof req.body?.locked !== 'boolean') return res.status(400).json({ error: 'locked must be boolean' });
  const locked = req.body.locked ? 1 : 0;
  await Threads.setLocked(String(req.params.threadId ?? ''), req.body.locked);
  const io = req.app.get('io');
  if (io) io.to(`channel:${thread.channelId}`).emit('forum:thread:updated', { threadId: thread._id, locked });
  res.json({ ok: true, locked });
});

// PATCH /api/threads/:threadId — rename, update tags
/**
 * @openapi
 * /threads/{threadId}:
 *   patch:
 *     tags: [Threads]
 *     summary: Thread güncelle
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               title: { type: string }
 *     responses:
 *       200:
 *         description: Güncellenmiş thread
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/Thread' }
 */
router.patch('/:threadId', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const thread = await Threads.findById(String(req.params.threadId ?? ''));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  const perms   = await channelPermissions(_u.id, thread.serverId, thread.channelId);
  const canEdit = hasPermission(perms, PERMS.VIEW_CHANNELS) &&
    (thread.createdBy === _u.id || hasPermission(perms, PERMS.MANAGE_MESSAGES));
  if (!canEdit) return res.status(403).json({ error: 'No permission' });

  const patch: Record<string, unknown> = {};
  const patchBody = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? req.body as Record<string, unknown> : {};
  if (patchBody.name != null) {
    if (typeof patchBody.name !== 'string' || !patchBody.name.trim())
      return res.status(400).json({ error: 'name invalid' });
    patch.name = patchBody.name.trim().slice(0, 100);
  }
  if (patchBody.tags != null) {
    if (!Array.isArray(patchBody.tags) || patchBody.tags.some(t => typeof t !== 'string'))
      return res.status(400).json({ error: 'tags must be a string array' });
    patch.tags = JSON.stringify(patchBody.tags.slice(0, 5).map(t => t.slice(0, 20)));
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });

  await Threads.update(String(req.params.threadId ?? ''), patch);
  const io = req.app.get('io');
  if (io) io.to(`channel:${thread.channelId}`).emit('forum:thread:updated', { threadId: thread._id });
  res.json({ ok: true });
});

// DELETE /api/threads/:threadId
/**
 * @openapi
 * /threads/{threadId}:
 *   delete:
 *     tags: [Threads]
 *     summary: Thread sil
 *     parameters:
 *       - in: path
 *         name: threadId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Thread silindi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.delete('/:threadId', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const thread = await Threads.findById(String(req.params.threadId ?? ''));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  const perms = await channelPermissions(_u.id, thread.serverId, thread.channelId);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.MANAGE_MESSAGES)) return res.status(403).json({ error: 'No permission' });

  await Threads.deleteThread(String(req.params.threadId ?? ''));
  await Messages.clearThreadFromParent(thread.parentMessageId);
  const io = req.app.get('io');
  if (io) io.to(`channel:${thread.channelId}`).emit('forum:thread:deleted', { threadId: thread._id, channelId: thread.channelId });

  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
