// server/routes/moderation.ts — Session 18: @openapi annotation eklendi
// Mevcut mantık değişmedi; key endpoint'lere JSDoc blokları eklendi.

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router({ mergeParams: true });
import { Auth, Users, Members, Servers, Messages } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import type { JwtPayload } from '../middleware/auth';
import { getMemberPerms, hasPermission, canActOn, PERMS } from './roles';
import { limits } from '../middleware/rateLimit';
// Sprint 121 FIX 12: permCache invalidation — kick/ban/timeout sonrası izin cache'ini temizle
import { invalidatePerms } from '../lib/permCache';

async function writeAudit(serverId: string, actor: JwtPayload, action: string, targetId: string, targetName: string, detail = ''): Promise<void> {
  await Auth.insertAuditLog({
    serverId,
    actorId: actor._id || actor.id,
    actorName: actor.displayName || actor.username,
    action, targetId, targetName, detail,
  });
}

/**
 * @openapi
 * /api/servers/{serverId}/audit-log:
 *   get:
 *     summary: Sunucu denetim günlüğünü getir
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *           maximum: 500
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *           description: Eylem filtresi (örn. ban, kick, timeout)
 *       - in: query
 *         name: format
 *         schema:
 *           type: string
 *           enum: [json, csv]
 *           default: json
 *     responses:
 *       200:
 *         description: Denetim günlüğü kayıtları
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 entries:
 *                   type: array
 *                 total:
 *                   type: integer
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
/**
 * @openapi
 * /servers/{sid}/audit-log:
 *   get:
 *     tags: [Moderation]
 *     summary: Denetim günlüğü
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50, maximum: 100 }
 *       - in: query
 *         name: before
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Denetim kayıtları
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: object }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/audit-log', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_MESSAGES) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }

  const limit  = Math.min(500, Math.max(1, parseInt(String(req.query.limit ?? ''))  || 100));
  const offset = Math.max(0,               parseInt(String(req.query.offset ?? '')) || 0);
  const action = req.query.action as string as string | undefined;
  const format = String(req.query.format as string || 'json');

  const { entries, total } = await Auth.getAuditLog(serverId, { limit, offset, action });

  if (format === 'csv') {
    const header = 'timestamp,actor,action,target,detail';
    const rows   = entries.map(e =>
      [e.createdAt, e.actorName, e.action, e.targetName, e.detail].join(',')
    );
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="audit-${serverId}.csv"`);
    return res.send([header, ...rows].join('\n'));
  }

  res.json({ entries, total });
});

/**
 * @openapi
 * /api/servers/{serverId}/members/{userId}/timeout:
 *   post:
 *     summary: Üyeye timeout uygula
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [durationMs]
 *             properties:
 *               durationMs:
 *                 type: integer
 *                 description: Timeout süresi (ms). 0 = kaldır.
 *                 example: 300000
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Timeout uygulandı
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         description: Üye bulunamadı
 */
/**
 * @openapi
 * /servers/{sid}/members/{userId}/timeout:
 *   post:
 *     tags: [Moderation]
 *     summary: Kullanıcıyı sustur (timeout)
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               duration: { type: integer, description: 'Süre (dakika)' }
 *               reason: { type: string }
 *     responses:
 *       200: { description: Timeout uygulandı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/members/:userId/timeout', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const userId = String(req.params.userId ?? '');
  const { durationMs: rawDurationMs, reason } = req.body as { durationMs?: unknown; reason?: string };
  const durationMs = Number(rawDurationMs ?? 0);

  // Güvenlik: kendine timeout önleme
  if (_u.id === userId) return res.status(400).json({ error: 'Kendinize timeout uygulayamazsınız' });

  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.TIMEOUT_MEMBERS) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }

  // Güvenlik: sunucu sahibine timeout önleme
  const server = await Servers.findById(serverId);
  if (server?.ownerId === userId) {
    return res.status(403).json({ error: 'Sunucu sahibine timeout uygulanamaz' });
  }

  // Güvenlik: daha yüksek yetkili üyeye timeout önleme
  const targetPerms = await getMemberPerms(userId, serverId);
  if (!(await canActOn(_u.id, userId, serverId))) {
    return res.status(403).json({ error: 'Daha yüksek yetkili bir üyeye timeout uygulayamazsınız' });
  }

  const target = await Users.findById(userId);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  const until = durationMs > 0 ? new Date(Date.now() + durationMs) : null;
  await Members.setTimeout(serverId, userId, until);
  await writeAudit(serverId, _u, durationMs > 0 ? 'timeout' : 'timeout_remove', userId, target.username, reason || '');
  // Sprint 121 FIX 12: Timeout sonrası permCache temizle
  invalidatePerms(serverId, userId);

  res.json({ ok: true, until });
});

/**
 * @openapi
 * /api/servers/{serverId}/members/{userId}/kick:
 *   post:
 *     summary: Üyeyi sunucudan at
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason:
 *                 type: string
 *     responses:
 *       200:
 *         description: Üye atıldı
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
/**
 * @openapi
 * /servers/{sid}/members/{userId}/kick:
 *   post:
 *     tags: [Moderation]
 *     summary: Kullanıcıyı at
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reason: { type: string }
 *     responses:
 *       200: { description: Kullanıcı atıldı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/members/:userId/kick', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const userId = String(req.params.userId ?? '');
  const { reason } = req.body as Record<string, string> ?? {};

  // Güvenlik: kendini kick etmeyi engelle
  if (_u.id === userId) return res.status(400).json({ error: 'Kendinizi kickleyemezsiniz' });

  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.KICK_MEMBERS) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }

  // Güvenlik: sunucu sahibini kick etmeyi engelle
  const server = await Servers.findById(serverId);
  if (server?.ownerId === userId) {
    return res.status(403).json({ error: 'Sunucu sahibi kicklenemez' });
  }

  // Güvenlik: hedefin izin seviyesi aktörün seviyesinden yüksekse engelle
  const targetPerms = await getMemberPerms(userId, serverId);
  if (!(await canActOn(_u.id, userId, serverId))) {
    return res.status(403).json({ error: 'Daha yüksek yetkili bir üzeyi kickleyemezsiniz' });
  }

  const target = await Users.findById(userId);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  await Members.removeMember(serverId, userId);
  await writeAudit(serverId, _u, 'kick', userId, target.username, reason || '');
  // Sprint 121 FIX 12: Kick sonrası permCache temizle — kullanıcı eski izinleriyle erişemez
  invalidatePerms(serverId, userId);

  res.json({ ok: true });
});

/**
 * @openapi
 * /api/servers/{serverId}/bans:
 *   get:
 *     summary: Ban listesini getir
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Banlı kullanıcı listesi
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *   post:
 *     summary: Kullanıcıyı banla
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId:
 *                 type: string
 *               reason:
 *                 type: string
 *               deleteMessageDays:
 *                 type: integer
 *                 default: 0
 *     responses:
 *       200:
 *         description: Kullanıcı banlandı
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
/**
 * @openapi
 * /servers/{sid}/bans:
 *   get:
 *     tags: [Moderation]
 *     summary: Ban listesi
 *     responses:
 *       200:
 *         description: Banlı kullanıcılar
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { type: object }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/bans', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.BAN_MEMBERS) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }
  const bans = await Members.getBans(serverId);
  res.json(bans);
});

/**
 * @openapi
 * /servers/{sid}/bans:
 *   post:
 *     tags: [Moderation]
 *     summary: Kullanıcıyı banla
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [userId]
 *             properties:
 *               userId: { type: string }
 *               reason: { type: string }
 *               deleteMessageDays: { type: integer, default: 0, maximum: 7 }
 *     responses:
 *       200: { description: Kullanıcı banlandı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post('/bans', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const { userId, reason, deleteMessageDays: rawDeleteMessageDays = 0 } = req.body as { userId?: string; reason?: string; deleteMessageDays?: unknown };
  if (!userId) return res.status(400).json({ error: 'userId required' });
  const deleteMessageDays = Number(rawDeleteMessageDays) || 0;

  // Güvenlik: kendini banlama önleme
  if (_u.id === userId) return res.status(400).json({ error: 'Kendinizi banlayamazsınız' });

  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.BAN_MEMBERS) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }

  // Güvenlik: sunucu sahibini banlama önleme
  const server = await Servers.findById(serverId);
  if (server?.ownerId === userId) {
    return res.status(403).json({ error: 'Sunucu sahibi banlanamaz' });
  }

  // Güvenlik: hedefin izin seviyesi aktörden yüksekse engelle
  const targetPerms = await getMemberPerms(userId, serverId);
  if (!(await canActOn(_u.id, userId, serverId))) {
    return res.status(403).json({ error: 'Daha yüksek yetkili bir üyeyi banlayamazsınız' });
  }

  const target = await Users.findById(userId);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });

  await Members.banMember(serverId, userId, reason);
  if (deleteMessageDays > 0) {
    const since = new Date(Date.now() - deleteMessageDays * 864e5);
    await Messages.deleteUserMessages(userId, serverId, since);
  }
  await writeAudit(serverId, _u, 'ban', userId, target.username, reason || '');
  // Sprint 121 FIX 12: Ban sonrası permCache temizle
  invalidatePerms(serverId, userId);

  res.json({ ok: true });
});

/**
 * @openapi
 * /api/servers/{serverId}/bans/{userId}:
 *   delete:
 *     summary: Banı kaldır (unban)
 *     tags: [Moderation]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: userId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Ban kaldırıldı
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
/**
 * @openapi
 * /servers/{sid}/bans/{userId}:
 *   delete:
 *     tags: [Moderation]
 *     summary: Ban kaldır
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Ban kaldırıldı }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.delete('/bans/:userId', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const userId = String(req.params.userId ?? '');
  const perms = await getMemberPerms(_u.id, serverId);
  if (!hasPermission(perms, PERMS.BAN_MEMBERS) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }
  const target = await Users.findById(userId);
  await Members.unbanMember(serverId, userId);
  await writeAudit(serverId, _u, 'unban', userId, target?.username || userId, '');
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
