// server/routes/federation/social.ts
// ActivityPub sosyal eylemler: Follow, Like, Boost + federated timeline
// YENİ — daha önce yoktu, ActivityPub tamamlaması için eklendi.

import express from 'express';
import { safeCastAuthed as castAuthed } from '../../lib/authSafe';
const router       = express.Router();
import { v4 as uuidv4 } from 'uuid';
import { generateKeyPairSync } from 'crypto';
import { Users, Federation, Notifications } from '../../db/repositories';
import { authMiddleware} from '../../middleware/auth';
import { limits } from '../../middleware/rateLimit';
import logger from '../../lib/logger';
import { sendFollowRequest, sendUnfollow, sendLike, sendAnnounce, deliverApActivity } from './delivery';
import { fetchT } from '../../lib/fetch';

/**
 * @openapi
 * /federation/follow:
 *   post:
 *     tags: [Federation]
 *     summary: Uzak kullanıcıyı takip et (ActivityPub Follow)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [actorUrl]
 *             properties:
 *               actorUrl: { type: string, format: uri, example: 'https://remote.instance/users/alice' }
 *     responses:
 *       200: { description: Takip isteği gönderildi }
 *       400: { description: actorUrl zorunludur }
 *       401: { description: Kimlik doğrulama gerekli }
 *   delete:
 *     tags: [Federation]
 *     summary: Takipten çık (ActivityPub Undo Follow)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [actorUrl]
 *             properties:
 *               actorUrl: { type: string, format: uri }
 *     responses:
 *       200: { description: Takipten çıkıldı }
 * /federation/following:
 *   get:
 *     tags: [Federation]
 *     summary: Takip edilen kullanıcı listesi
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Takip edilen kullanıcılar
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 following: { type: array, items: { type: object } }
 * /federation/followers:
 *   get:
 *     tags: [Federation]
 *     summary: Takipçi listesi
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Takipçiler
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 followers: { type: array, items: { type: object } }
 * /federation/like:
 *   post:
 *     tags: [Federation]
 *     summary: ActivityPub Like — içeriği beğen
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [objectUrl]
 *             properties:
 *               objectUrl: { type: string, format: uri }
 *     responses:
 *       200: { description: Beğeni gönderildi }
 *   delete:
 *     tags: [Federation]
 *     summary: Beğeniyi geri al (ActivityPub Undo Like)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [objectUrl]
 *             properties:
 *               objectUrl: { type: string, format: uri }
 *     responses:
 *       200: { description: Beğeni geri alındı }
 * /federation/announce:
 *   post:
 *     tags: [Federation]
 *     summary: ActivityPub Announce (Boost/Repost)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [objectUrl]
 *             properties:
 *               objectUrl: { type: string, format: uri }
 *     responses:
 *       200: { description: Boost gönderildi }
 * /federation/timeline:
 *   get:
 *     tags: [Federation]
 *     summary: Federasyon zaman çizelgesi
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *       - in: query
 *         name: before
 *         schema: { type: string, description: Cursor (ISO timestamp) }
 *     responses:
 *       200:
 *         description: ActivityPub Note listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items:   { type: array, items: { type: object } }
 *                 hasMore: { type: boolean }
 * /federation/notifications:
 *   get:
 *     tags: [Federation]
 *     summary: Federasyon bildirimleri
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Bildirim listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 items: { type: array, items: { type: object } }
 * /federation/notifications/read-all:
 *   patch:
 *     tags: [Federation]
 *     summary: Tüm federasyon bildirimlerini okundu işaretle
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Bildirimler okundu işaretlendi }
 * /federation/profile:
 *   get:
 *     tags: [Federation]
 *     summary: Uzak kullanıcı profili getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: actorUrl
 *         required: true
 *         schema: { type: string, format: uri }
 *     responses:
 *       200: { description: Kullanıcı profili }
 *       400: { description: actorUrl zorunludur }

 *
 * /federation/social/follow:
 *   post:
 *     tags: [Federation]
 *     summary: Uzak kullaniciyi takip et
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [actorUrl]
 *             properties:
 *               actorUrl: { type: string, format: uri }
 *     responses:
 *       200:
 *         description: Takip istegi gonderildi
 *   delete:
 *     tags: [Federation]
 *     summary: Takipten cik
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [actorUrl]
 *             properties:
 *               actorUrl: { type: string, format: uri }
 *     responses:
 *       200:
 *         description: Takipten cikaldi
 *
 * /federation/social/following:
 *   get:
 *     tags: [Federation]
 *     summary: Takip edilenleri listele
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Takip listesi
 *
 * /federation/social/followers:
 *   get:
 *     tags: [Federation]
 *     summary: Takipcileri listele
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Takipci listesi
 *
 * /federation/social/like:
 *   post:
 *     tags: [Federation]
 *     summary: Uzak icerigi begeni
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [objectUrl]
 *             properties:
 *               objectUrl: { type: string, format: uri }
 *     responses:
 *       200:
 *         description: Begeni gonderildi
 *   delete:
 *     tags: [Federation]
 *     summary: Begeniyi geri al
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [objectUrl]
 *             properties:
 *               objectUrl: { type: string, format: uri }
 *     responses:
 *       200:
 *         description: Begeni geri alindi
 *
 * /federation/social/announce:
 *   post:
 *     tags: [Federation]
 *     summary: Icerigi federe networkte paylash (boost)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [objectUrl]
 *             properties:
 *               objectUrl: { type: string, format: uri }
 *     responses:
 *       200:
 *         description: Paylasim gonderildi
 *
 * /federation/social/timeline:
 *   get:
 *     tags: [Federation]
 *     summary: Federe sosyal zaman cizelgesi
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *       - in: query
 *         name: before
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Zaman cizelgesi
 *
 * /federation/social/notifications:
 *   get:
 *     tags: [Federation]
 *     summary: Federation bildirimlerini listele
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Bildirim listesi
 *
 * /federation/social/notifications/read-all:
 *   patch:
 *     tags: [Federation]
 *     summary: Tum bildirimleri okundu isaretle
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Okundu
 *
 * /federation/social/profile:
 *   get:
 *     tags: [Federation]
 *     summary: Kullanicinin federe profil bilgisi
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: ActivityPub Actor profili
 */
router.post('/follow', authMiddleware, limits.federation(), async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const { actorUrl } = req.body as Record<string, string>;
  if (!actorUrl) return res.status(400).json({ error: 'actorUrl required' });

  const user = await Users.findById(_u.id);
  if (!user) return res.status(401).json({ error: 'Not found' });

  // AP key yoksa oluştur
  if (!user.apPublicKey) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    // SECURITY: saveApKeys apPrivateKey'i ayrı tabloya yazar, users'a yazmaz
    await Users.saveApKeys(user._id, publicKey, privateKey);
    user.apPublicKey = publicKey;
    // apPrivateKey user nesnesine EKLENMİYOR
  }

  const existing = await Federation.findApOutgoingFollowOne({
    fromUserId: user._id, targetActorUrl: actorUrl,
  });
  if (existing) return res.status(409).json({ error: 'Already following' });

  const followActivity = await sendFollowRequest(user, actorUrl);
  res.json({ ok: true, activity: followActivity });
});

// ── DELETE /api/federation/follow — Takibi bırak ──────────────
router.delete('/follow', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const { actorUrl } = req.body as Record<string, string>;
  if (!actorUrl) return res.status(400).json({ error: 'actorUrl required' });

  const user = await Users.findById(_u.id);
  if (!user) return res.status(401).json({ error: 'Not found' });

  await sendUnfollow(user, actorUrl);
  res.json({ ok: true });
});

// ── GET /api/federation/following — Takip edilenler listesi ────
router.get('/following', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const outgoing = await Federation.findApOutgoingFollows({ fromUserId: _u.id }) || [];
  const arr = Array.isArray(outgoing) ? outgoing : await outgoing;
  res.json(arr.map(f => ({
    actorUrl:  f.targetActorUrl,
    accepted:  f.accepted,
    createdAt: f.createdAt,
  })));
});

// ── GET /api/federation/followers — Takipçiler listesi ─────────
router.get('/followers', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const follows = await Federation.findApFollows({ targetUserId: _u.id }) || [];
  const arr = Array.isArray(follows) ? follows : await follows;
  res.json(arr.map(f => ({
    actorUrl:  f.actorUrl,
    createdAt: f.createdAt,
  })));
});

// ── POST /api/federation/like — Uzak notu beğen ───────────────
router.post('/like', authMiddleware, limits.federation(), async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const { objectUrl } = req.body as Record<string, string>;
  if (!objectUrl) return res.status(400).json({ error: 'objectUrl required' });

  const user = await Users.findById(_u.id);
  if (!user?.apPublicKey) return res.status(400).json({ error: 'ActivityPub key not set up. Follow someone first.' });

  const activity = await sendLike(user, objectUrl);
  res.json({ ok: true, activity });
});

// ── DELETE /api/federation/like — Beğeniyi geri al ────────────
router.delete('/like', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const { objectUrl } = req.body as Record<string, string>;
  if (!objectUrl) return res.status(400).json({ error: 'objectUrl required' });

  const user = await Users.findById(_u.id);
  if (!user) return res.status(401).json({ error: 'Not found' });

  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  const url = `${instanceUrl}/api/federation/users/${user.username}`;

  const like = await Federation.findApLikeOne({ fromUserId: user._id, objectUrl });
  if (!like) return res.status(404).json({ error: 'Like not found' });

  const undoActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id:         `${url}/activities/${uuidv4()}`,
    type:       'Undo',
    actor:      url,
    object:     { type: 'Like', actor: url, object: objectUrl },
  };
  await Federation.removeApLike({ _id: like._id }, {});
  await deliverApActivity(objectUrl, undoActivity, user);
  res.json({ ok: true });
});

// ── POST /api/federation/announce — Boost / Reblog ────────────
router.post('/announce', authMiddleware, limits.federation(), async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const { objectUrl } = req.body as Record<string, string>;
  if (!objectUrl) return res.status(400).json({ error: 'objectUrl required' });

  const user = await Users.findById(_u.id);
  if (!user?.apPublicKey) return res.status(400).json({ error: 'ActivityPub key not set up.' });

  const activity = await sendAnnounce(user, objectUrl);
  res.json({ ok: true, activity });
});

// ── GET /api/federation/timeline — Federated timeline ──────────
// Takip edilen uzak aktörlerin son postları (apMessages)
router.get('/timeline', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const page    = Math.max(1, parseInt(String(req.query.page ?? ''), 10) || 1);
  const limit   = Math.min(50, parseInt(String(req.query.limit ?? ''), 10) || 20);
  const skip    = (page - 1) * limit;

  // Kullanıcının takip ettiği uzak aktörleri bul
  const outgoing   = await Federation.findApOutgoingFollows({ fromUserId: _u.id, accepted: true }) || [];
  const arr        = Array.isArray(outgoing) ? outgoing : await outgoing;
  const actorUrls  = arr.map(f => f.targetActorUrl);

  if (!actorUrls.length) return res.json({ items: [], total: 0, page, limit, pages: 0 });

  // Bu aktörlerden gelen mesajlar
  const q = { actorUrl: { $in: actorUrls } };
  let items = await Federation.apMessagesFind(q).sort({ published: -1 }).skip(skip).limit(limit) || [];
  if (!Array.isArray(items)) items = await items || [];

  const total = await Federation.countApMessages(q);

  res.json({ items, total, page, limit, pages: Math.ceil((total || 0) / limit) });
});

// ── GET /api/federation/notifications — AP bildirimleri ────────
router.get('/notifications', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const limit = Math.min(50, parseInt(String(req.query.limit ?? ''), 10) || 20);
  const items = await Notifications.inboxFind({
    userId: _u.id,
    type:   { $in: ['ap_follow', 'ap_mention', 'ap_like', 'ap_announce'] },
  }).sort({ createdAt: -1 }).limit(limit) || [];

  res.json(Array.isArray(items) ? items : await items || []);
});

// ── PATCH /api/federation/notifications/read-all ───────────────
router.patch('/notifications/read-all', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  await Notifications.updateInboxMany(
    { userId: _u.id, type: { $in: ['ap_follow', 'ap_mention', 'ap_like', 'ap_announce'] }, read: false },
    { $set: { read: true } },
    { multi: true }
  );
  res.json({ ok: true });
});

// ── GET /api/federation/profile/:actorUrl — Uzak profil getir ──
router.get('/profile', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = castAuthed(req).user;
  const actorUrl = typeof req.query.actorUrl === 'string' ? req.query.actorUrl : '';
  if (!actorUrl) return res.status(400).json({ error: 'actorUrl required' });

  try {
    const r = await fetchT(actorUrl, {
      headers: { Accept: 'application/activity+json' },
      timeoutMs: 8000,
    });
    if (!r.ok) throw new Error('Remote returned ' + r.status);
    const actor = await r.json();

    // Takip durumu
    const isFollowing = !!(await Federation.findApOutgoingFollowOne({
      fromUserId: _u.id, targetActorUrl: actorUrl,
    }));
    const isFollower = !!(await Federation.findApFollowOne({
      actorUrl, targetUserId: _u.id,
    }));

    res.json({
      id:                actor.id,
      type:              actor.type,
      preferredUsername: actor.preferredUsername,
      name:              actor.name,
      summary:           actor.summary,
      url:               actor.url,
      icon:              actor.icon,
      image:             actor.image,
      inbox:             actor.inbox,
      followers:         actor.followers,
      following:         actor.following,
      isFollowing,
      isFollower,
    });
  } catch (_err) { const err = _err as Error;
    res.status(502).json({ error: `Could not fetch actor: ${err.message}` });
  }
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
