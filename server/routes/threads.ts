// server/routes/threads.js (v17 + forum extensions)
// Thread system + Forum kanalı: oluşturma, liste, pin, lock, tags
const express      = require('express');
const router       = express.Router();
const { Threads, Members, Channels, Users, Messages } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { getMemberPerms, hasPermission, PERMS } = require('./roles');
const { limits } = require('../middleware/rateLimit');
const { processNotifications } = require('../lib/notifications');

// ── helpers ────────────────────────────────────────────────────
async function memberCheck(userId, serverId) {
  return Members.findOne(userId, serverId);
}

// ── Forum: POST /api/threads — forum kanalında yeni ileti VEYA mesajdan thread
router.post('/', authMiddleware, limits.messages(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { parentMessageId, name, channelId, firstMessage, tags } = req.body;

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
    const now  = Date.now();

    const thread = await Threads.insert({
      channelId,
      serverId:         channel.serverId,
      parentMessageId:  null,
      name:             name.trim().slice(0, 100),
      firstMessage:     (firstMessage || '').slice(0, 500),
      tags:             JSON.stringify((tags || []).slice(0, 5).map(t => t.slice(0, 20))),
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
        avatarColor: user.avatarColor || '#5865f2',
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
}));

// GET /api/threads/:threadId — thread info
router.get('/:threadId', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const thread = await Threads.findById(req.params.threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const member = await memberCheck(_u.id, thread.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  res.json(thread);
}));

// GET /api/threads/:threadId/messages — paginated thread messages
router.get('/:threadId/messages', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const thread = await Threads.findById(req.params.threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const member = await memberCheck(_u.id, thread.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  const limit  = Math.min(parseInt(String(req.query.limit ?? '')) || 50, 100);
  const before = parseInt(String(req.query.before ?? '')) || Date.now() + 1;

  const msgs = await Threads.findMessages(req.params.threadId, { limit, before });
  res.json(msgs.reverse());
}));

// POST /api/threads/:threadId/messages — send a message to a thread
router.post('/:threadId/messages', authMiddleware, limits.messages(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: 'content required' });
  if (content.length > 2000) return res.status(400).json({ error: 'Message too long' });

  const thread = await Threads.findById(req.params.threadId);
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
      { ...msg, userId: _u.id, displayName: user.displayName },
      io,
      socketUsers
    ).catch(() => {});
  }

  res.json(msg);
}));

// GET /api/threads/channel/:channelId — list threads in a channel (forum aware)
router.get('/channel/:channelId', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await Channels.findById(req.params.channelId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const member = await memberCheck(_u.id, channel.serverId);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  const { sort = 'latest', tag, search } = req.query;
  let threads = await Threads.findByChannel(req.params.channelId);

  // filter
  if (tag)    threads = threads.filter(t => { try { return JSON.parse(t.tags||'[]').includes(tag); } catch { return false; } });
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
    tags: (() => { try { return JSON.parse(t.tags || '[]'); } catch { return []; } })(),
  }));

  res.json(threads);
}));

// PATCH /api/threads/:threadId/pin — pin/unpin (mod only)
router.patch('/:threadId/pin', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const thread = await Threads.findById(req.params.threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const perms = await getMemberPerms(_u.id, thread.serverId);
  if (!hasPermission(perms, PERMS.MANAGE_MESSAGES)) return res.status(403).json({ error: 'No permission' });

  const pinned = req.body.pinned ? 1 : 0;
  await Threads.setPinned(req.params.threadId, !!req.body.pinned);
  const io = req.app.get('io');
  if (io) io.to(`server:${thread.serverId}`).emit('forum:thread:updated', { threadId: thread._id, pinned });
  res.json({ ok: true, pinned });
}));

// PATCH /api/threads/:threadId/lock — lock/unlock (mod only)
router.patch('/:threadId/lock', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const thread = await Threads.findById(req.params.threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });
  const perms = await getMemberPerms(_u.id, thread.serverId);
  if (!hasPermission(perms, PERMS.MANAGE_MESSAGES)) return res.status(403).json({ error: 'No permission' });

  const locked = req.body.locked ? 1 : 0;
  await Threads.setLocked(req.params.threadId, !!req.body.locked);
  const io = req.app.get('io');
  if (io) io.to(`server:${thread.serverId}`).emit('forum:thread:updated', { threadId: thread._id, locked });
  res.json({ ok: true, locked });
}));

// PATCH /api/threads/:threadId — rename, update tags
router.patch('/:threadId', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const thread = await Threads.findById(req.params.threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  const perms   = await getMemberPerms(_u.id, thread.serverId);
  const canEdit = thread.createdBy === _u.id || hasPermission(perms, PERMS.MANAGE_MESSAGES);
  if (!canEdit) return res.status(403).json({ error: 'No permission' });

  const patch: Record<string,any> = {};
  if (req.body.name != null) patch.name = req.body.name.trim().slice(0, 100);
  if (req.body.tags != null) patch.tags = JSON.stringify((req.body.tags || []).slice(0, 5).map(t => String(t).slice(0, 20)));
  if (!Object.keys(patch).length) return res.status(400).json({ error: 'Nothing to update' });

  await Threads.update(req.params.threadId, patch);
  res.json({ ok: true });
}));

// DELETE /api/threads/:threadId
router.delete('/:threadId', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const thread = await Threads.findById(req.params.threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  const perms = await getMemberPerms(_u.id, thread.serverId);
  if (!hasPermission(perms, PERMS.MANAGE_MESSAGES)) return res.status(403).json({ error: 'No permission' });

  await Threads.deleteThread(req.params.threadId);
  await Messages.clearThreadFromParent(thread.parentMessageId);

  res.json({ ok: true });
}));

module.exports = router;
export {};
