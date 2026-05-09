// server/routes/friends.js — Friend System
const express = require('express');
const router  = express.Router();
const { Social, Users } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { sanitizeUser } = require('./auth');
const { limits } = require('../middleware/rateLimit');

// GET /api/friends
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const rows      = await Social.findFriendships(_u.id);
  const accepted  = rows.filter(r => r.status === 'accepted');
  const friendIds = accepted.map(r => r.userId === _u.id ? r.friendId : r.userId);
  const users     = await Users.findByIds(friendIds);
  res.json(users.map(sanitizeUser));
}));

// GET /api/friends/pending
router.get('/pending', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const rows      = await Social.findFriendships(_u.id);
  const pending   = rows.filter(r => r.friendId === _u.id && r.status === 'pending');
  const senderIds = pending.map(r => r.userId);
  const users     = await Users.findByIds(senderIds);
  const userMap   = {};
  users.forEach(u => { userMap[u._id] = sanitizeUser(u); });
  res.json(pending.map(r => ({ ...r, sender: userMap[r.userId] })));
}));

// GET /api/friends/blocked
router.get('/blocked', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const rows = await Social.findBlocksByUser(_u.id);
  const ids  = rows.map(r => r.blockedId);
  if (!ids.length) return res.json([]);
  const users = await Users.findByIds(ids);
  res.json(users.map(sanitizeUser));
}));

// POST /api/friends/request
router.post('/request', authMiddleware, limits.friends(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const target = await Users.findByUsername(username);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target._id === _u.id) return res.status(400).json({ error: 'Cannot add yourself' });

  const existing = await Social.findFriendship(_u.id, target._id);
  if (existing) return res.status(409).json({ error: 'Request already exists or already friends' });

  const friendship = await Social.insertFriendship(_u.id, target._id, 'pending');
  res.json(friendship);
}));

// POST /api/friends/:id/accept
router.post('/:id/accept', authMiddleware, limits.friends(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const rows   = await Social.findFriendships(_u.id);
  const row    = rows.find(r => r._id === req.params.id && r.friendId === _u.id && r.status === 'pending');
  if (!row) return res.status(404).json({ error: 'Not found' });
  await Social.updateFriendship(req.params.id, { status: 'accepted' });
  res.json({ ok: true });
}));

// DELETE /api/friends/:id
router.delete('/:id', authMiddleware, limits.friends(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const rows = await Social.findFriendships(_u.id);
  const row  = rows.find(r => r._id === req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.userId !== _u.id && row.friendId !== _u.id)
    return res.status(403).json({ error: 'Forbidden' });
  await Social.removeFriendship(req.params.id);
  res.json({ ok: true });
}));

// POST /api/friends/block/:uid
router.post('/block/:uid', authMiddleware, limits.friends(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const blockerId = _u.id;
  const blockedId = req.params.uid;
  if (blockerId === blockedId) return res.status(400).json({ error: 'Cannot block yourself' });

  const existing = await Social.findBlock(blockerId, blockedId);
  if (existing) return res.json({ ok: true, alreadyBlocked: true });

  await Social.insertBlock(blockerId, blockedId);

  const friendship = await Social.findFriendship(blockerId, blockedId);
  if (friendship) await Social.removeFriendship(friendship._id);

  res.json({ ok: true });
}));

// DELETE /api/friends/block/:uid
router.delete('/block/:uid', authMiddleware, limits.friends(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  await Social.removeBlock(_u.id, req.params.uid);
  res.json({ ok: true });
}));

module.exports = router;
export {};
