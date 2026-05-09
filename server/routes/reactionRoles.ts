// server/routes/reactionRoles.js
// Reaction Roles: emoji reaksiyonuna tıklanınca otomatik rol alma/bırakma
//
// GET    /api/servers/:sid/reaction-roles            — sunucunun tüm rr kuralları
// POST   /api/servers/:sid/reaction-roles            — yeni kural ekle
// DELETE /api/servers/:sid/reaction-roles/:rrId      — kural sil

'use strict';

const express      = require('express');
const router       = express.Router({ mergeParams: true });
const { Members, ReactionRoles } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { getMemberPerms, hasPermission, PERMS } = require('./roles');
const { limits } = require('../middleware/rateLimit');

// ── GET /api/servers/:sid/reaction-roles ─────────────────────
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sid } = req.params;
  const membership = await Members.findOne(_u.id, sid);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const rules = await ReactionRoles.findByServer(sid);
  res.json(rules);
}));

// ── POST /api/servers/:sid/reaction-roles ────────────────────
router.post('/', authMiddleware, limits.roles(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sid } = req.params;
  const perms = await getMemberPerms(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_ROLES)) {
    return res.status(403).json({ error: 'MANAGE_ROLES yetkisi gerekli' });
  }
  const { channelId, messageId, emoji, roleId } = req.body;
  if (!channelId || !messageId || !emoji || !roleId) {
    return res.status(400).json({ error: 'channelId, messageId, emoji ve roleId zorunlu' });
  }
  if (emoji.length > 64) return res.status(400).json({ error: 'Emoji çok uzun' });

  const existing = await ReactionRoles.findDuplicate(messageId, emoji, roleId);
  if (existing) return res.status(409).json({ error: 'Bu kural zaten mevcut' });

  const rule = await ReactionRoles.insert({
    serverId: sid, channelId, messageId, emoji, roleId, createdBy: _u.id,
  });
  res.json(rule);
}));

// ── DELETE /api/servers/:sid/reaction-roles/:rrId ────────────
router.delete('/:rrId', authMiddleware, limits.roles(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { sid, rrId } = req.params;
  const perms = await getMemberPerms(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_ROLES)) {
    return res.status(403).json({ error: 'MANAGE_ROLES yetkisi gerekli' });
  }
  const rule = await ReactionRoles.findByIdAndServer(rrId, sid);
  if (!rule) return res.status(404).json({ error: 'Kural bulunamadı' });
  await ReactionRoles.delete(rrId);
  res.json({ ok: true });
}));

module.exports = router;
export {};
