// server/routes/stats.js — PostgreSQL & SQLite uyumlu
'use strict';

const express      = require('express');
const router       = express.Router();
const { Members, Channels, Messages } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

// GET /api/servers/:serverId/stats
router.get('/:serverId/stats', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const membership = await Members.findOne(_u.id, req.params.serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });

  const [memberCount, channels, totalMessages] = await Promise.all([
    Members.countWhere({ serverId: req.params.serverId }),
    Channels.findByServer(req.params.serverId),
    Messages.count({ serverId: req.params.serverId }),
  ]);

  // En aktif kullanıcılar (son 30 gün)
  const since30d   = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recentMsgs = await Messages.findWhere({ serverId: req.params.serverId, createdAt: { $gt: since30d } });
  const userCounts = {};
  for (const m of recentMsgs) {
    if (!userCounts[m.userId]) userCounts[m.userId] = { userId: m.userId, displayName: m.displayName, msgCount: 0 };
    userCounts[m.userId].msgCount++;
  }
  const topUsers = Object.values(userCounts)
    .sort((a: any, b: any) => b.msgCount - a.msgCount)
    .slice(0, 10);

  res.json({ memberCount, totalMessages, channelCount: channels.length, topUsers });
}));

module.exports = router;
export {};
