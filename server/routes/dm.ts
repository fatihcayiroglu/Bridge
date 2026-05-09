// server/routes/dm.js — Direct Messages
const express    = require('express');
const router     = express.Router();
const { Dms, Users } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { sanitizeUser }   = require('./auth');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit');

function getDmId(a, b) { return [a, b].sort().join(':'); }

// GET /api/dm
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const convs  = await Dms.findConversationsByUser(_u.id);
  const result: any[] = [];
  for (const conv of convs) {
    const otherId = conv.participants.find(p => p !== _u.id);
    const other   = await Users.findById(otherId);
    if (other) result.push({ ...conv, other: sanitizeUser(other) });
  }
  res.json(result);
}));

// POST /api/dm/:userId
router.post('/:userId', authMiddleware, limits.dm(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const other = await Users.findById(req.params.userId);
  if (!other)                    return res.status(404).json({ error: 'User not found' });
  if (other._id === _u.id) return res.status(400).json({ error: 'Cannot DM yourself' });

  const { conv, dmId } = await Dms.findOrCreateConversation(_u.id, other._id);
  res.json({ ...conv, _id: dmId, other: sanitizeUser(other) });
}));

// GET /api/dm/:dmId/messages
router.get('/:dmId/messages', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const conv = await Dms.findConversation(req.params.dmId);
  if (!conv) return res.status(404).json({ error: 'Conversation not found' });
  if (!conv.participants.includes(_u.id)) return res.status(403).json({ error: 'Forbidden' });

  const limit    = Math.min(parseInt(String(req.query.limit ?? '')) || 50, 100);
  const before   = parseInt(String(req.query.before ?? '')) || Date.now() + 1;
  const messages = await Dms.findMessages(req.params.dmId, { limit, before });
  res.json(messages.reverse());
}));

module.exports = { router, getDmId };
export {};
