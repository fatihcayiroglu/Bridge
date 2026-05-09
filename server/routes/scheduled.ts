// server/routes/scheduled.js
const express = require('express');
const router  = express.Router();
const { Members, ScheduledMessages } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { getMemberPerms, hasPermission, PERMS } = require('./roles');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit');

// POST /api/scheduled
router.post('/', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { channelId, serverId, content, sendAt } = req.body;
  if (!channelId || !serverId || !content?.trim() || !sendAt)
    return res.status(400).json({ error: 'channelId, serverId, content, sendAt required' });
  const ts = new Date(sendAt).getTime();
  if (isNaN(ts) || ts <= Date.now()) return res.status(400).json({ error: 'sendAt must be a future date' });
  if (ts - Date.now() > 30 * 24 * 60 * 60 * 1000) return res.status(400).json({ error: 'Cannot schedule more than 30 days ahead' });

  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.SEND_MESSAGES)) return res.status(403).json({ error: 'No SEND_MESSAGES permission' });

  const msg = await ScheduledMessages.insert({
    channelId, serverId,
    userId:      _u.id,
    displayName: _u.displayName || _u.username,
    username:    _u.username,
    avatarColor: _u.avatarColor,
    content:     content.trim().slice(0, 2000),
    sendAt:      ts,
  });
  res.json(msg);
}));

// GET /api/scheduled
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const msgs = await ScheduledMessages.findPending(_u.id);
  res.json(msgs);
}));

// DELETE /api/scheduled/:id
router.delete('/:id', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const msg = await ScheduledMessages.findById(req.params.id, _u.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  if (msg.sent) return res.status(400).json({ error: 'Already sent' });
  await ScheduledMessages.delete(req.params.id);
  res.json({ cancelled: true });
}));

module.exports = router;
export {};
