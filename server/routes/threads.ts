// server/routes/threads.ts (v17 + forum extensions)
// Thread system + Forum kanalı: oluşturma, liste, pin, lock, tags
import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router       = express.Router();
import { Threads, Members, Channels, Users, Messages } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { getMemberPerms, hasPermission, PERMS } from './roles';
import { limits } from '../middleware/rateLimit';
import { processNotifications } from '../lib/notifications';

// ── helpers ────────────────────────────────────────────────────
async function memberCheck(userId: string, serverId: string) {
  return Members.findOne(userId, serverId);
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
  const { parentMessageId, name, channelId, firstMessage } = req.body as Record<string, string>;
  const rawTags = Array.isArray(req.body?.tags) ? req.body.tags : [];

  // ── Forum channel thread (channelId + name) ───────────────────
  if (channelId && !parentMessageId) {
    if (!name?.trim()) return res.status(400).json({ error: 'name required' });

    const channel = await Channels.findById(channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (channel.type !== 'forum') return res.status(400).json({ error: 'Not a forum channel' });

    const member = await memberCheck(_u.id, channel.serverId);
    if (!member) return res.status(403).json({ error: 'Not a member' });
    if (member.timeoutUntil && member.timeoutUntil > Date.now())
      return res.status(403).json({ error: 'You are timed out', until: member.timeoutUntil });

    const perms = await getMemberPerms(_u.id, channel.serverId);
    if (!hasPermission(perms, PERMS.SEND_MESSAGES)) return res.status(403).json({ error: 'No permission' });

    const user = await Users.findById(_u.id);
    if (!user) return res.status(401).json({ error: 'User not found' });
    const now  = Date.now();

    const thread = await Threads.insert({
      channelId,
      serverId:         channel.serverId,
      parentMessageId:  null,
      name:             name.trim().slice(0, 100),
      firstMessage:     (firstMessage || '').slice(0, 500),
      tags:             JSON.stringify(rawTags.slice(0, 5).map((t: unknown) => String(t).slice(0, 20))),
      createdBy:        _u.id,
      createdAt:        now,
      lastMessageAt:    now,
      messageCount:     firstMessage?.trim() ? 1 : 0,
      participantCount: 1,
      pinned:           0,
      locked:           0,
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
    if (io) io.to(`server:${channel.serverId}`).emit('forum:thread:created', thread);

    return res.status(201).json({ thread });
  }

  // ── Normal message thread ──────────────────────────────────────
  if (!parentMessageId) return res.status(400).json({ error: 'parentMessageId required' });

  const parent = await Messages.findById(parentMessageId);
  if (!parent) return res.status(404).json({ error: 'Message not found' });

  const member = await memberCheck(_u.id, parent.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  // One thread per message
  const existing = await Threads.findByParentMessage(parentMessageId);
  if (existing) return res.status(409).json({ error: 'Thread already exists', thread: existing });

  const threadName = (name?.trim() || parent.content?.slice(0, 50) || 'Thread').slice(0, 100);
  const thread = await Threads.insert({
    channelId:       parent.channelId,
    serverId:        parent.serverId,
    parentMessageId,
    name:            threadName,
    createdBy:       _u.id,
    createdAt:       Date.now(),
    lastMessageAt:   Date.now(),
    messageCount:    0,
  });

  // Tag original message with threadId
  await Messages.update(parentMessageId, { threadId: thread._id });

  res.json(thread);
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

  const limit  = Math.min(parseInt(String(req.query.limit ?? '')) || 50, 100);
  const before = parseInt(String(req.query.before ?? '')) || Date.now() + 1;

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
  const { content } = req.body as Record<string, string>;
  if (!content?.trim()) return res.status(400).json({ error: 'content required' });
  if (content.length > 2000) return res.status(400).json({ error: 'Message too long' });

  const thread = await Threads.findById(String(req.params.threadId ?? ''));
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  const member = await memberCheck(_u.id, thread.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  // timeout check
  if (member.timeoutUntil && member.timeoutUntil > Date.now()) {
    return res.status(403).json({ error: 'You are timed out', until: member.timeoutUntil });
  }

  const perms = await getMemberPerms(_u.id, thread.serverId);
  if (!hasPermission(perms, PERMS.SEND_MESSAGES)) return res.status(403).json({ error: 'No permission' });

  const user = await Users.findById(_u.id);
  if (!user) return res.status(401).json({ error: 'User not found' });

  const msg = await Threads.insertMessage({
    threadId:    thread._id,
    channelId:   thread.channelId,
    serverId:    thread.serverId,
    userId:      _u.id,
    username:    user.username,
    displayName: user.displayName,
    avatarColor: user.avatarColor,
    content:     content.trim(),
    type:        'normal',
    reactions:   {},
    createdAt:   Date.now(),
  });

  await Threads.recordReply(thread._id, thread.parentMessageId);

  // Notify thread participants (mention detection + thread reply notification)
  const io          = req.app.get('io');
  const socketUsers = req.app.get('socketUsers');
  if (io && socketUsers) {
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

    // Send real-time thread:reply event to each participant's sockets
    for (const uid of participantIds) {
      for (const [sid, su] of socketUsers) {
        if ((su._id || su.id) === uid) {
          io.to(sid).emit('notification:thread_reply', {
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
      }
    }

    // Standard mention notifications (handles @username in thread messages)
    await processNotifications(
      { ...msg, channelId: msg.channelId ?? thread.channelId, serverId: msg.serverId ?? thread.serverId, userId: _u.id, displayName: user.displayName },
      io,
      socketUsers
    ).catch(() => {});
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

  const sort = String(req.query.sort ?? 'latest');
  const tag = typeof req.query.tag === 'string' ? req.query.tag : '';
  const search = typeof req.query.search === 'string' ? req.query.search : '';
  let threads = await Threads.findByChannel(String(req.params.channelId ?? ''));

  // filter
  if (tag)    threads = threads.filter(t => { try { return JSON.parse(String(t.tags || '[]')).includes(tag); } catch { return false; } });
  if (search) threads = threads.filter(t => t.name.toLowerCase().includes(search.toLowerCase()));

  // sort
  if (sort === 'top')     threads.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));
  else if (sort === 'new') threads.sort((a, b) => b.createdAt - a.createdAt);
  else                     threads.sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));

  // pinned first
  threads.sort((a, b) => (b.pinned || 0) - (a.pinned || 0));

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
  const perms = await getMemberPerms(_u.id, thread.serverId);
  if (!hasPermission(perms, PERMS.MANAGE_MESSAGES)) return res.status(403).json({ error: 'No permission' });

  const pinned = req.body.pinned ? 1 : 0;
  await Threads.setPinned(String(req.params.threadId ?? ''), !!req.body.pinned);
  const io = req.app.get('io');
  if (io) io.to(`server:${thread.serverId}`).emit('forum:thread:updated', { threadId: thread._id, pinned });
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
  const perms = await getMemberPerms(_u.id, thread.serverId);
  if (!hasPermission(perms, PERMS.MANAGE_MESSAGES)) return res.status(403).json({ error: 'No permission' });

  const locked = req.body.locked ? 1 : 0;
  await Threads.setLocked(String(req.params.threadId ?? ''), !!req.body.locked);
  const io = req.app.get('io');
  if (io) io.to(`server:${thread.serverId}`).emit('forum:thread:updated', { threadId: thread._id, locked });
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

  const perms   = await getMemberPerms(_u.id, thread.serverId);
  const canEdit = thread.createdBy === _u.id || hasPermission(perms, PERMS.MANAGE_MESSAGES);
  if (!canEdit) return res.status(403).json({ error: 'No permission' });

  const patch: Record<string, unknown> = {};
  if (req.body.name != null) patch.name = req.body.name.trim().slice(0, 100);
  if (req.body.tags != null) {
    const bodyTags = Array.isArray(req.body.tags) ? req.body.tags : [];
    patch.tags = JSON.stringify(bodyTags.slice(0, 5).map((t: unknown) => String(t).slice(0, 20)));
  }
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });

  await Threads.update(String(req.params.threadId ?? ''), patch);
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

  const perms = await getMemberPerms(_u.id, thread.serverId);
  if (!hasPermission(perms, PERMS.MANAGE_MESSAGES)) return res.status(403).json({ error: 'No permission' });

  await Threads.deleteThread(String(req.params.threadId ?? ''));
  await Messages.clearThreadFromParent(thread.parentMessageId);

  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
