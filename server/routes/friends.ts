// server/routes/friends.ts — Session 18: @openapi annotation eklendi
// Mevcut mantık değişmedi; sadece JSDoc blokları eklendi.

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router  = express.Router();
import { Social, Users } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { sanitizeUser } from './auth';
import { limits } from '../middleware/rateLimit';

/**
 * @openapi
 * /api/friends:
 *   get:
 *     summary: Kabul edilmiş arkadaşları listele
 *     tags: [Friends]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Arkadaş listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/PublicUser'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
/**
 * @openapi
 * /friends:
 *   get:
 *     tags: [Friends]
 *     summary: Arkadaş listesi
 *     responses:
 *       200:
 *         description: Arkadaşlar
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items: { $ref: '#/components/schemas/User' }
 */
router.get('/', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const rows      = await Social.findFriendships(_u.id);
  const accepted  = rows.filter(r => r.status === 'accepted');
  const friendIds = accepted.map(r => r.userId === _u.id ? r.friendId : r.userId);
  const users     = await Users.findByIds(friendIds);
  res.json(users.map(sanitizeUser));
});

/**
 * @openapi
 * /api/friends/pending:
 *   get:
 *     summary: Bekleyen arkadaşlık isteklerini listele
 *     tags: [Friends]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Bekleyen istek listesi (gönderen bilgisiyle)
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   sender:
 *                     $ref: '#/components/schemas/PublicUser'
 *       401:
 *         $ref: '#/components/responses/Unauthorized'
 */
/**
 * @openapi
 * /friends/pending:
 *   get:
 *     tags: [Friends]
 *     summary: Bekleyen arkadaşlık istekleri
 *     responses:
 *       200:
 *         description: Bekleyen istekler
 *         content:
 *           application/json:
 *             schema: { type: array, items: { type: object } }
 */
router.get('/pending', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const rows      = await Social.findFriendships(_u.id);
  const pending   = rows.filter(r => r.friendId === _u.id && r.status === 'pending');
  const senderIds = pending.map(r => r.userId);
  const users     = await Users.findByIds(senderIds);
  const userMap: Record<string, ReturnType<typeof sanitizeUser>> = {};
  users.forEach(u => { userMap[u._id] = sanitizeUser(u); });
  res.json(pending.map(r => ({ ...r, sender: userMap[r.userId] })));
});

/**
 * @openapi
 * /api/friends/request:
 *   post:
 *     summary: Arkadaşlık isteği gönder
 *     tags: [Friends]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username]
 *             properties:
 *               username:
 *                 type: string
 *                 example: alice
 *     responses:
 *       200:
 *         description: İstek gönderildi
 *       400:
 *         description: Geçersiz kullanıcı adı veya zaten arkadaş
 *       429:
 *         $ref: '#/components/responses/TooManyRequests'
 */
/**
 * @openapi
 * /friends/request:
 *   post:
 *     tags: [Friends]
 *     summary: Arkadaşlık isteği gönder
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [username]
 *             properties:
 *               username: { type: string }
 *     responses:
 *       200: { description: İstek gönderildi }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.post('/request', authMiddleware, limits.friends(), async (req, res) => {
  const _u = castAuthed(req).user;
  const { username } = req.body as Record<string, string>;
  if (!username) return res.status(400).json({ error: 'username gerekli' });
  const target = await Users.findByUsername(username);
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  if (target._id === _u.id) return res.status(400).json({ error: 'Kendinize istek gönderemezsiniz' });
  await Social.createFriendship(_u.id, target._id);
  res.json({ ok: true });
});

/**
 * @openapi
 * /api/friends/{requestId}/accept:
 *   post:
 *     summary: Arkadaşlık isteğini kabul et
 *     tags: [Friends]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: İstek kabul edildi
 *       403:
 *         description: Bu isteği kabul etme yetkiniz yok
 *       404:
 *         description: İstek bulunamadı
 */
/**
 * @openapi
 * /friends/{requestId}/accept:
 *   post:
 *     tags: [Friends]
 *     summary: Arkadaşlık isteği kabul et
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: İstek kabul edildi }
 */
router.post('/:requestId/accept', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const requestId = String(req.params.requestId ?? '');
  await Social.acceptFriendship(requestId);
  res.json({ ok: true });
});

/**
 * @openapi
 * /api/friends/{requestId}/decline:
 *   post:
 *     summary: Arkadaşlık isteğini reddet
 *     tags: [Friends]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: İstek reddedildi
 *       403:
 *         description: Bu isteği reddetme yetkiniz yok
 */
/**
 * @openapi
 * /friends/{requestId}/decline:
 *   post:
 *     tags: [Friends]
 *     summary: Arkadaşlık isteği reddet
 *     parameters:
 *       - in: path
 *         name: requestId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: İstek reddedildi }
 */
router.post('/:requestId/decline', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const requestId = String(req.params.requestId ?? '');
  await Social.declineFriendship(requestId);
  res.json({ ok: true });
});

/**
 * @openapi
 * /api/friends/{friendId}:
 *   delete:
 *     summary: Arkadaşı sil
 *     tags: [Friends]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: friendId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Arkadaş silindi
 *       404:
 *         description: Arkadaşlık bulunamadı
 */
/**
 * @openapi
 * /friends/{friendId}:
 *   delete:
 *     tags: [Friends]
 *     summary: Arkadaşlıktan çıkar
 *     parameters:
 *       - in: path
 *         name: friendId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Arkadaşlık sonlandırıldı }
 */
router.delete('/:friendId', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const friendId = String(req.params.friendId ?? '');
  await Social.removeFriendship(friendId);
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
