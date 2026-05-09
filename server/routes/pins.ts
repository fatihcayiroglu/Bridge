// server/routes/pins.js (extracted from index.js)
const express      = require('express');
const router       = express.Router();
const { Channels, Members, Messages } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

// GET /api/channels/:cid/pins
router.get('/:cid/pins', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await Channels.findById(req.params.cid);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const membership = await Members.findOne(_u.id, channel.serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const pins = await Messages.findPinsInChannel(req.params.cid, 50);
  res.json(pins);
}));

// GET /api/channels/:cid/files
router.get('/:cid/files', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await Channels.findById(req.params.cid);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const membership = await Members.findOne(_u.id, channel.serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const limit  = Math.min(parseInt(String(req.query.limit ?? '')) || 50, 100);
  const before = parseInt(String(req.query.before ?? '')) || Date.now() + 1;
  const files  = await Messages.messagesFind({
    channelId: req.params.cid,
    type:      'file',
    createdAt: { $lt: before },
  }).sort({ createdAt: -1 }).limit(limit);
  res.json(files.reverse());
}));

module.exports = router;
export {};
