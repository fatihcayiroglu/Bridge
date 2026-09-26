// server/routes/users.ts
// Public user profile + mutual servers
import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router       = express.Router();
import { Users, Members, Servers } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { isUserOnline } from '../lib/presenceCache';
import { sanitizeUser, normalizePresenceVisibility } from '../lib/userUtils';

// GET /api/users/:userId — public profile
/**
 * @openapi
 * /users/{userId}:
 *   get:
 *     tags: [Users]
 *     summary: Kullanıcı profili getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: userId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Kullanıcı profili
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/UserProfile' }
 *       404: { description: Kullanıcı bulunamadı }
 */
router.get('/:userId', authMiddleware, async (req, res) => {
  const user = await Users.findById(String(req.params.userId ?? ''));
  if (!user) return res.status(404).json({ error: 'User not found' });

  const profile = sanitizeUser(user);
  const viewerId = castAuthed(req).user.id;
  const hidden = normalizePresenceVisibility(user.presenceVisibility) === 'hidden' && viewerId !== user._id;

  // Presence visibility applies to every public profile surface, not only the
  // dedicated /presence endpoint. Unknown/legacy values fail closed.
  profile.status      = hidden ? 'offline' : (user.status || 'offline');
  profile.statusText  = hidden ? '' : (user.statusText || '');
  profile.statusEmoji = hidden ? '' : (user.statusEmoji || '');
  profile.createdAt   = user.createdAt;

  res.json(profile);
});

// GET /api/users/:userId/mutual-servers
/**
 * @openapi
 * /users/{userId}/mutual-servers:
 *   get:
 *     tags: [Users]
 *     summary: Ortak sunucuları listele
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: userId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Ortak sunucu listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   _id:  { type: string }
 *                   name: { type: string }
 *                   icon: { type: string }
 */
router.get('/:userId/mutual-servers', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const myMemberships     = await Members.findByUser(_u.id);
  const theirMemberships  = await Members.findByUser(String(req.params.userId ?? ''));

  const myServerIds    = new Set(myMemberships.map(m => m.serverId));
  const theirServerIds = theirMemberships.map(m => m.serverId).filter(id => myServerIds.has(id));

  if (!theirServerIds.length) return res.json([]);

  const servers = await Servers.find({ _id: { $in: theirServerIds } });
  res.json(servers.map(s => ({ _id: s._id, name: s.name, icon: s.icon, iconUrl: s.iconUrl || null })));
});

// GET /api/users/:userId/presence
/**
 * @openapi
 * /users/{userId}/presence:
 *   get:
 *     tags: [Users]
 *     summary: Kullanıcı anlık çevrimiçi durumu
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: userId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200:
 *         description: Çevrimiçi durum
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 userId:     { type: string }
 *                 online:     { type: boolean }
 *                 status:     { type: string, enum: [online, idle, dnd, offline] }
 *                 statusText: { type: string }
 *       404: { description: Kullanıcı bulunamadı }
 */
router.get('/:userId/presence', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const userId = String(req.params.userId ?? '');
  const online = await isUserOnline(userId);
  // DB'den güncel status metnini de döndür
  const user = await Users.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // `presenceVisibility=hidden` yalnız canlı online bitini değil, presence
  // endpoint'inin tamamını gizler. Aksi halde `online:false` denirken kalıcı
  // status/statusText/statusEmoji alanları hedefin gerçek durumunu sızdırır.
  // Kullanıcı kendi presence tercihlerini görmeye devam eder.
  const hidden = normalizePresenceVisibility(user.presenceVisibility) === 'hidden' && _u.id !== userId;
  res.json({
    userId,
    online:      hidden ? false : online,
    status:      hidden ? 'offline' : (user.status || 'offline'),
    statusText:  hidden ? '' : (user.statusText || ''),
    statusEmoji: hidden ? '' : (user.statusEmoji || ''),
  });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
