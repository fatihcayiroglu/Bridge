// server/routes/bridge.js — Channel Bridge (message forwarding)
const express = require('express');
const router  = express.Router();
const { v4: uuidv4 } = require('uuid');
const { Bridges } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { getMemberPerms, hasPermission, PERMS } = require('./roles');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

// POST /api/bridges — create a bridge between two channels
router.post('/', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sourceChannelId, targetChannelId, sourceServerId, targetServerId, label } = req.body;
  if (!sourceChannelId || !targetChannelId || !sourceServerId || !targetServerId) {
    return res.status(400).json({ error: 'sourceChannelId, targetChannelId, sourceServerId, targetServerId required' });
  }
  if (sourceChannelId === targetChannelId) return res.status(400).json({ error: 'Cannot bridge a channel to itself' });

  // Must have MANAGE_CHANNELS in both servers
  const [sp, tp] = await Promise.all([
    getMemberPerms(_u.id, sourceServerId),
    getMemberPerms(_u.id, targetServerId),
  ]);
  if (!hasPermission(sp, PERMS.MANAGE_CHANNELS) && !hasPermission(sp, PERMS.ADMINISTRATOR))
    return res.status(403).json({ error: 'No permission in source server' });
  if (!hasPermission(tp, PERMS.MANAGE_CHANNELS) && !hasPermission(tp, PERMS.ADMINISTRATOR))
    return res.status(403).json({ error: 'No permission in target server' });

  // Check for duplicate
  const existing = await Bridges.findOne({ sourceChannelId, targetChannelId });
  if (existing) return res.status(409).json({ error: 'Bridge already exists' });

  const bridge = await Bridges.insert({
    _id: uuidv4(), sourceChannelId, targetChannelId,
    sourceServerId, targetServerId,
    label: (label || '').slice(0, 64),
    createdBy: _u.id,
    createdAt: Date.now(),
    active: true,
  });
  res.json(bridge);
}));

// GET /api/bridges?channelId=xxx — get bridges for a channel
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const { channelId } = req.query;
  if (!channelId) return res.status(400).json({ error: 'channelId required' });
  const bridges = await Bridges.find({
    $or: [{ sourceChannelId: channelId }, { targetChannelId: channelId }],
    active: true,
  });
  res.json(bridges);
}));

// DELETE /api/bridges/:id — remove bridge
router.delete('/:id', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const bridge = await Bridges.findOne({ _id: req.params.id });
  if (!bridge) return res.status(404).json({ error: 'Not found' });
  const perms = await getMemberPerms(_u.id, bridge.sourceServerId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS) && !hasPermission(perms, PERMS.ADMINISTRATOR))
    return res.status(403).json({ error: 'No permission' });
  await Bridges.update({ _id: req.params.id }, { $set: { active: false } });
  res.json({ removed: true });
}));

module.exports = router;
export {};
