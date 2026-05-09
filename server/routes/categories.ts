// server/routes/categories.js — Channel Categories
const express = require('express');
const router = express.Router({ mergeParams: true });
const { Channels, Members } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { getMemberPerms, hasPermission, PERMS } = require('./roles');
const { limits } = require('../middleware/rateLimit');

// GET /api/servers/:serverId/categories
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId } = req.params;
  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const cats = await Channels.findCategoriesByServer(serverId);
  res.json(cats);
}));

// POST /api/servers/:serverId/categories
router.post('/', authMiddleware, limits.channels(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId } = req.params;
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'No permission' });
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  const count = await Channels.countCategories(serverId);
  const cat = await Channels.insertCategory({
    serverId, name: name.trim().toUpperCase(), position: count, collapsed: false,
  });
  res.json(cat);
}));

// PATCH /api/servers/:serverId/categories/:catId
router.patch('/:catId', authMiddleware, limits.channels(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId, catId } = req.params;
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'No permission' });
  const { name, position, collapsed } = req.body;
  const $set: Record<string,any> = {};
  if (name !== undefined) $set.name = name.trim().toUpperCase();
  if (position !== undefined) $set.position = parseInt(position);
  if (collapsed !== undefined) $set.collapsed = collapsed ? 1 : 0;
  await Channels.updateCategory(catId, serverId, $set);
  res.json({ ok: true });
}));

// DELETE /api/servers/:serverId/categories/:catId
router.delete('/:catId', authMiddleware, limits.channels(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId, catId } = req.params;
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'No permission' });
  await Channels.deleteCategory(catId, serverId);
  await Channels.unlinkCategory(catId, serverId);
  res.json({ ok: true });
}));

// POST /api/servers/:serverId/categories/reorder — bulk position update
router.post('/reorder', authMiddleware, limits.channels(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId } = req.params;
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS)) return res.status(403).json({ error: 'No permission' });
  const { order } = req.body; // array of { id, position }
  if (!Array.isArray(order)) return res.status(400).json({ error: 'order array required' });
  for (const item of order) {
    await Channels.updateCategory(item.id, serverId, { position: item.position });
  }
  res.json({ ok: true });
}));

module.exports = router;
export {};
