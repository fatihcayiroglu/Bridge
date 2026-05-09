// @ts-nocheck
// server/routes/messages.js
const express = require("express");
const router  = express.Router();


const { Messages, Channels, Members } = require("../db/repositories");
const { authMiddleware, castAuthed } = require("../middleware/auth");
const { limits }   = require("../middleware/rateLimit");
const asyncHandler = require("../middleware/asyncHandler");
const { validateBody, schemas } = require("../middleware/validate");
const { cache }    = require("../lib/redisAdapter");
const { sanitizeMessage } = require("../lib/security");
const { resolvePermissions, hasPermission, PERMS } = require("../lib/permissions");
const { clearUnread } = require("../lib/notifications");

async function requireChannelMembership(userId, channelId, res) {
  const cacheKey = `channel:${channelId}`;
  let channel = await cache.get(cacheKey);
  if (!channel) {
    channel = await Channels.findById(channelId);
    if (channel) await cache.set(cacheKey, channel, 60);
  }
  if (!channel) { res.status(404).json({ error: "Channel not found" }); return null; }
  const membership = await Members.findOne(userId, channel.serverId);
  if (!membership) { res.status(403).json({ error: "Not a member" }); return null; }
  return channel;
}

// GET /api/channels/:cid/messages — opaque cursor-based pagination
// Cursor formatı: base64(JSON({ ts, id, dir }))
// Query params:
//   cursor=<opaque>  → bu cursor'dan devam et
//   before=<ts>      → legacy (geriye dönük uyumluluk)
//   after=<ts>       → legacy
//   limit=<n>        → max 100, varsayılan 50
//   q=<search>       → içerik arama
router.get("/:cid/messages", authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await requireChannelMembership(_u.id, req.params.cid, res);
  if (!channel) return;

  const perms = await resolvePermissions(_u.id, channel.serverId, req.params.cid);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS))
    return res.status(403).json({ error: "No permission to view this channel" });
  if (!hasPermission(perms, PERMS.READ_HISTORY))
    return res.status(403).json({ error: "No permission to read message history" });

  const limit = Math.min(parseInt(String(req.query.limit ?? '')) || 50, 100);

  // Opaque cursor decode
  let cursorData = null;
  if (req.query.cursor) {
    try {
      cursorData = JSON.parse(Buffer.from(String(req.query.cursor ?? ''), 'base64').toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
  }

  const legacyBefore = req.query.before ? parseInt(String(req.query.before ?? '')) : null;
  const legacyAfter  = req.query.after  ? parseInt(String(req.query.after ?? ''))  : null;
  const isFirstPage  = !req.query.cursor && !legacyBefore && !legacyAfter && !req.query.q;
  const cacheKey     = `messages:${req.params.cid}:first:${limit}`;

  if (isFirstPage) {
    const cached = await cache.get(cacheKey);
    if (cached) {
      res.setHeader("X-Cache", "HIT");
      clearUnread(_u.id, req.params.cid).catch(() => {});
      return res.json(cached);
    }
  }

  const query   = { channelId: req.params.cid };
  let   sortDir = -1;

  if (cursorData) {
    if (cursorData.dir === 'after') {
      query.createdAt = { $gt: cursorData.ts };
      sortDir = 1;
    } else {
      query.createdAt = { $lt: cursorData.ts };
      sortDir = -1;
    }
  } else if (legacyAfter) {
    query.createdAt = { $gt: legacyAfter };
    sortDir = 1;
  } else if (legacyBefore) {
    query.createdAt = { $lt: legacyBefore };
    sortDir = -1;
  } else {
    query.createdAt = { $lt: Date.now() + 1 };
    sortDir = -1;
  }

  if (req.query.q?.trim()) {
    const q       = req.query.q.trim().slice(0, 100);
    const escaped = q.replace(/[-[\]/{}()*+?.\\^$|]/g, "\\$&");
    query.content = { $regex: escaped, $options: "i" };
  }

  // limit+1 → hasMore kontrolü
  const raw     = await Messages.findByChannel(req.params.cid, { limit: limit + 1, before: cursorData?.ts || legacyBefore, after: cursorData?.dir === 'after' ? cursorData?.ts : legacyAfter, search: req.query.q?.trim().slice(0, 100) });
  const hasMore = raw.length > limit;
  const page    = hasMore ? raw.slice(0, limit) : raw;
  if (sortDir === -1) page.reverse(); // kronolojik sıra

  // Cursor üret
  let nextCursor: string | null = null;
  let prevCursor = null;
  if (page.length > 0) {
    const oldest = page[0];
    const newest = page[page.length - 1];
    prevCursor = Buffer.from(JSON.stringify({ ts: oldest.createdAt, id: oldest._id, dir: 'before' })).toString('base64');
    if (hasMore || cursorData?.dir === 'after') {
      nextCursor = Buffer.from(JSON.stringify({ ts: newest.createdAt, id: newest._id, dir: 'after' })).toString('base64');
    }
  }

  const response = { messages: page, hasMore, nextCursor, prevCursor, limit, count: page.length };

  if (isFirstPage && !req.query.q) await cache.set(cacheKey, response, 10);
  clearUnread(_u.id, req.params.cid).catch(() => {});
  res.setHeader("X-Cache", "MISS");
  res.json(response);
}));


// GET /api/channels/:cid/pinned
router.get('/:cid/pinned', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await requireChannelMembership(_u.id, req.params.cid, res);
  if (!channel) return;
  const pinned = await Messages.findPinned(req.params.cid);
  res.json(pinned);
}));

// DELETE /api/messages/:id
router.delete('/:id', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const msg = await Messages.findById(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const membership = await Members.findOne(_u.id, msg.serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member of this server' });

  const { getMemberPerms, hasPermission, PERMS } = require('./roles');
  const perms     = await getMemberPerms(_u.id, msg.serverId);
  const canDelete = msg.userId === _u.id || hasPermission(perms, PERMS.MANAGE_MESSAGES);
  if (!canDelete) return res.status(403).json({ error: 'Not your message' });

  await Messages.delete(req.params.id);
  res.json({ deleted: true, id: req.params.id });
}));

// PATCH /api/messages/:id  — edit message (geçmişi sakla)
router.patch('/:id', authMiddleware, limits.messages(),
  validateBody(schemas.message),
  asyncHandler(async (req, res) => {
    const _u = castAuthed(req).user;
    const msg = await Messages.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    if (msg.userId !== _u.id) return res.status(403).json({ error: 'Not your message' });
    if (msg.type !== 'normal') return res.status(400).json({ error: 'Cannot edit this message type' });

    const history = Array.isArray(msg.editHistory) ? msg.editHistory : [];
    history.push({ content: msg.content, editedAt: msg.editedAt || msg.createdAt });
    const trimmedHistory = history.slice(-10);

    await Messages.update(req.params.id, { content: req.body.content.trim(), editedAt: Date.now(), editHistory: trimmedHistory });
    const updated = await Messages.findById(req.params.id);
    res.json(updated);
  })
);

// GET /api/messages/:id/history — düzenleme geçmişini getir
router.get('/:id/history', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const msg = await Messages.findById(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  // Mesajın kanalına erişim kontrolü
  const channel = await requireChannelMembership(_u.id, msg.channelId, res);
  if (!channel) return;

  res.json({ editHistory: Array.isArray(msg.editHistory) ? msg.editHistory : [], current: { content: msg.content, editedAt: msg.editedAt } });
}));

// POST /api/messages/:id/react  — toggle emoji reaction
router.post('/:id/react', authMiddleware, limits.react(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { emoji } = req.body;
  if (!emoji || typeof emoji !== 'string' || emoji.length > 12)
    return res.status(400).json({ error: 'Invalid emoji' });

  const msg = await Messages.findById(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Message not found' });

  const membership = await Members.findOne(_u.id, msg.serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });

  const reactions = msg.reactions || {};
  if (!reactions[emoji] && Object.keys(reactions).length >= 20)
    return res.status(400).json({ error: 'Max 20 unique reactions per message' });

  const users = reactions[emoji] || [];
  const idx   = users.indexOf(_u.id);
  if (idx === -1) users.push(_u.id); else users.splice(idx, 1);
  if (users.length === 0) delete reactions[emoji]; else reactions[emoji] = users;

  await Messages.update(req.params.id, { reactions });
  const updated = await Messages.findById(req.params.id);
  res.json(updated);
}));

module.exports = router;
export {};
