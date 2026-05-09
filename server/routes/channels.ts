// @ts-nocheck
// server/routes/channels.js — Channel management (create/rename/delete)
// NOTE: These routes duplicate the ones now in servers.js.
// They are kept for backward compatibility; servers.js takes precedence
// when both are mounted (servers.js mounted last wins on conflicts).
const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const router     = express.Router();
const { Channels, Messages } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { getMemberPerms, hasPermission, PERMS } = require('./roles');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

// POST /api/servers/:sid/channels
router.post('/:sid/channels', authMiddleware, limits.channels(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { name, type, topic, category } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Channel name required' });
  if (!['text','voice'].includes(type)) return res.status(400).json({ error: 'Invalid channel type' });

  const existing = await Channels.findByServer(req.params.sid);
  const channel  = await Channels.insert({
    _id:       uuidv4(),
    serverId:  req.params.sid,
    name:      name.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-').slice(0, 32),
    type:      type === 'voice' ? 'voice' : 'text',
    topic:     topic?.trim().slice(0, 100) || '',
    category:  category?.trim().toUpperCase().slice(0, 32) || 'GENERAL',
    order:     existing.length,
    createdAt: Date.now(),
  });
  res.json(channel);
}));

// PATCH /api/servers/:sid/channels/:cid
router.patch('/:sid/channels/:cid', authMiddleware, limits.channels(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const { name, topic, category, order, slowmode, forumTags } = req.body;
  const updates = {};
  if (name?.trim())              updates.name     = name.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-').slice(0, 32);
  if (typeof topic === 'string') updates.topic    = topic.trim().slice(0, 100);
  if (category?.trim())          updates.category = category.trim().toUpperCase().slice(0, 32);
  if (typeof order === 'number') updates.order    = order;
//   Slow mode (saniye cinsinden, 0 = kapalı, max 21600 = 6 saat)
  if (typeof slowmode === 'number') {
    const ALLOWED = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];
    updates.slowmode = ALLOWED.includes(slowmode) ? slowmode : 0;
  }
//   Forum etiketleri (en fazla 20, her biri {id, name, color})
  if (Array.isArray(forumTags)) {
    updates.forumTags = JSON.stringify(
      forumTags.slice(0, 20).map(t => ({
        id:    String(t.id   || `tag-${Date.now()}-${Math.random()}`).slice(0, 40),
        name:  String(t.name || '').trim().slice(0, 20),
        color: /^#[0-9a-fA-F]{6}$/.test(t.color) ? t.color : '#5865f2',
      })).filter(t => t.name)
    );
  }
  if (Object.keys(updates).length === 0) return res.status(400).json({ error: 'Nothing to update' });

  await Channels.updateByIdAndServer(req.params.cid, req.params.sid, updates);
  const raw = await Channels.findById(req.params.cid);
  // Parse forumTags JSON string → array
  const updated = raw ? {
    ...raw,
    forumTags: (() => { try { return JSON.parse(raw.forumTags || '[]'); } catch { return []; } })(),
  } : raw;
  res.json(updated);
}));

// GET /api/servers/:sid/channels/:cid — tek kanal detayı (forumTags dahil)
router.get('/:sid/channels/:cid', authMiddleware, asyncHandler(async (req, res) => {
  const ch = await Channels.findByIdAndServer(req.params.cid, req.params.sid);
  if (!ch) return res.status(404).json({ error: 'Channel not found' });
  res.json({
    ...ch,
    forumTags: (() => { try { return JSON.parse(ch.forumTags || '[]'); } catch { return []; } })(),
  });
}));

// DELETE /api/servers/:sid/channels/:cid
router.delete('/:sid/channels/:cid', authMiddleware, limits.channels(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await getMemberPerms(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_CHANNELS))
    return res.status(403).json({ error: 'Missing permission: MANAGE_CHANNELS' });

  const channels = await Channels.findByServer(req.params.sid);
  if (channels.length <= 1)
    return res.status(400).json({ error: 'Cannot delete the last channel' });

  await Channels.delete(req.params.cid);
  await Messages.deleteByChannel(req.params.cid);
  res.json({ deleted: true });
}));

module.exports = router;
export {};
