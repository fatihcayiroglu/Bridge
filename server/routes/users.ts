// server/routes/users.js
// Public user profile + mutual servers
const express      = require('express');
const router       = express.Router();
const { Users, Members, Servers } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { sanitizeUser } = require('./auth');

// GET /api/users/:userId — public profile
router.get('/:userId', authMiddleware, asyncHandler(async (req, res) => {
  const user = await Users.findById(req.params.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const profile = sanitizeUser(user);
  // Add extra public fields
  profile.statusText  = user.statusText  || '';
  profile.statusEmoji = user.statusEmoji || '';
  profile.createdAt   = user.createdAt;

  res.json(profile);
}));

// GET /api/users/:userId/mutual-servers — servers both users share
router.get('/:userId/mutual-servers', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const myMemberships     = await Members.findByUser(_u.id);
  const theirMemberships  = await Members.findByUser(req.params.userId);

  const myServerIds    = new Set(myMemberships.map(m => m.serverId));
  const theirServerIds = theirMemberships.map(m => m.serverId).filter(id => myServerIds.has(id));

  if (!theirServerIds.length) return res.json([]);

  const servers = await Servers.find({ _id: { $in: theirServerIds } });
  res.json(servers.map(s => ({ _id: s._id, name: s.name, icon: s.icon, iconUrl: s.iconUrl || null })));
}));

module.exports = router;
export {};
