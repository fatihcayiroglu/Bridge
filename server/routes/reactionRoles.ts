// server/routes/reactionRoles.ts
// Reaction Roles: emoji reaksiyonuna tıklanınca otomatik rol alma/bırakma
//
// GET    /api/servers/:sid/reaction-roles            — sunucunun tüm rr kuralları
// POST   /api/servers/:sid/reaction-roles            — yeni kural ekle
// DELETE /api/servers/:sid/reaction-roles/:rrId      — kural sil


import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router       = express.Router({ mergeParams: true });
import { Channels, Members, Messages, ReactionRoles, Roles } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { getMemberPerms, hasPermission, PERMS } from './roles';
import { canManageRole, canViewChannel } from '../lib/permissions';
import { limits } from '../middleware/rateLimit';

// ── GET /api/servers/:sid/reaction-roles ─────────────────────
/**
 * @openapi
 * /reaction-roles:
 *   get:
 *     tags: [Roles]
 *     summary: Sunucunun reaction role listesi
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Reaction role listesi }
 *       401: { description: Kimlik doğrulaması gerekli }
 */
router.get('/', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const membership = await Members.findOne(_u.id, sid);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const rules = await ReactionRoles.findByServer(sid);
  const visible = [];
  for (const rule of rules) {
    if (await canViewChannel(_u.id, sid, String(rule.channelId ?? ''))) visible.push(rule);
  }
  res.json(visible);
});

// ── POST /api/servers/:sid/reaction-roles ────────────────────
/**
 * @openapi
 * /reaction-roles:
 *   post:
 *     tags: [Roles]
 *     summary: Yeni reaction role oluştur
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [messageId, emoji, roleId]
 *             properties:
 *               messageId: { type: string }
 *               emoji:     { type: string }
 *               roleId:    { type: string }
 *               channelId: { type: string }
 *     responses:
 *       201: { description: Reaction role oluşturuldu }
 *       400: { description: Geçersiz istek }
 *       403: { description: Yetki yok }
 */
router.post('/', authMiddleware, limits.roles(), async (req, res) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const perms = await getMemberPerms(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_ROLES)) {
    return res.status(403).json({ error: 'MANAGE_ROLES yetkisi gerekli' });
  }
  const { channelId, messageId, emoji, roleId } = req.body as Record<string, string>;
  if (!channelId || !messageId || !emoji || !roleId) {
    return res.status(400).json({ error: 'channelId, messageId, emoji ve roleId zorunlu' });
  }
  if (emoji.length > 64) return res.status(400).json({ error: 'Emoji çok uzun' });

  // Tenant + hierarchy authority: identifiers supplied by the client are never
  // trusted to belong to this server. Resolve the full chain before storing a
  // rule so a malformed/hostile rule cannot later grant a foreign role.
  const channel = await Channels.findByIdAndServer(channelId, sid);
  if (!channel) return res.status(404).json({ error: 'Channel not found in this server' });
  if (!await canViewChannel(_u.id, sid, channelId)) return res.status(403).json({ error: 'Channel is not visible' });

  const message = await Messages.findById(messageId);
  if (!message || String(message.channelId) !== channelId || String(message.serverId) !== sid) {
    return res.status(404).json({ error: 'Message not found in this channel' });
  }

  const role = await Roles.findByIdAndServer(roleId, sid);
  if (!role) return res.status(404).json({ error: 'Role not found in this server' });
  if (!await canManageRole(_u.id, roleId, sid)) {
    return res.status(403).json({ error: 'Role hierarchy prevents managing this role' });
  }

  const created = await ReactionRoles.createIfAbsent({
    serverId: sid, channelId, messageId, emoji, roleId, createdBy: _u.id,
  });
  if (!created.created) return res.status(409).json({ error: 'Bu kural zaten mevcut' });
  res.json(created.rule);
});

// ── DELETE /api/servers/:sid/reaction-roles/:rrId ────────────
/**
 * @openapi
 * /reaction-roles/{rrId}:
 *   delete:
 *     tags: [Roles]
 *     summary: Reaction role sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: rrId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204: { description: Silindi }
 *       403: { description: Yetki yok }
 *       404: { description: Bulunamadı }
 */
router.delete('/:rrId', authMiddleware, limits.roles(), async (req, res) => {
  const _u = castAuthed(req).user;
  const sid = String(req.params.sid ?? '');
  const rrId = String(req.params.rrId ?? '');
  const perms = await getMemberPerms(_u.id, sid);
  if (!hasPermission(perms, PERMS.MANAGE_ROLES)) {
    return res.status(403).json({ error: 'MANAGE_ROLES yetkisi gerekli' });
  }
  const rule = await ReactionRoles.findByIdAndServer(rrId, sid);
  if (!rule) return res.status(404).json({ error: 'Kural bulunamadı' });
  const role = await Roles.findByIdAndServer(String(rule.roleId ?? ''), sid);
  if (role && !await canManageRole(_u.id, String(rule.roleId), sid)) {
    return res.status(403).json({ error: 'Role hierarchy prevents managing this role' });
  }
  await ReactionRoles.delete(rrId);
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
