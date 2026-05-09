// @ts-nocheck
'use strict';
// server/routes/federation/social.js
// ActivityPub sosyal eylemler: Follow, Like, Boost + federated timeline
// YENİ — daha önce yoktu, ActivityPub tamamlaması için eklendi.

const express      = require('express');
const router       = express.Router();
const { v4: uuidv4 } = require('uuid');
const { Users, Federation, Notifications } = require('../../db/repositories');
const { authMiddleware, castAuthed } = require('../../middleware/auth');
const asyncHandler = require('../../middleware/asyncHandler');
const { limits }   = require('../../middleware/rateLimit');
const logger       = require('../../lib/logger');
const {
  sendFollowRequest, sendUnfollow, sendLike, sendAnnounce,
} = require('./delivery');

// ── POST /api/federation/follow — Uzak aktörü takip et ─────────
router.post('/follow', authMiddleware, limits.federation(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { actorUrl } = req.body;
  if (!actorUrl) return res.status(400).json({ error: 'actorUrl required' });

  const user = await Users.findById(_u.id);
  if (!user) return res.status(401).json({ error: 'Not found' });

  // AP key yoksa oluştur
  if (!user.apPrivateKey) {
    const { generateKeyPairSync } = require('crypto');
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding:  { type: 'spki',  format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    await Users.update(user._id, { apPublicKey: publicKey, apPrivateKey: privateKey });
    user.apPublicKey  = publicKey;
    user.apPrivateKey = privateKey;
  }

  const existing = await Federation.findApOutgoingFollowOne({
    fromUserId: user._id, targetActorUrl: actorUrl,
  });
  if (existing) return res.status(409).json({ error: 'Already following' });

  const followActivity = await sendFollowRequest(user, actorUrl);
  res.json({ ok: true, activity: followActivity });
}));

// ── DELETE /api/federation/follow — Takibi bırak ──────────────
router.delete('/follow', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { actorUrl } = req.body;
  if (!actorUrl) return res.status(400).json({ error: 'actorUrl required' });

  const user = await Users.findById(_u.id);
  if (!user) return res.status(401).json({ error: 'Not found' });

  await sendUnfollow(user, actorUrl);
  res.json({ ok: true });
}));

// ── GET /api/federation/following — Takip edilenler listesi ────
router.get('/following', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const outgoing = await Federation.findApOutgoingFollows({ fromUserId: _u.id }) || [];
  const arr = Array.isArray(outgoing) ? outgoing : await outgoing;
  res.json(arr.map(f => ({
    actorUrl:  f.targetActorUrl,
    accepted:  f.accepted,
    createdAt: f.createdAt,
  })));
}));

// ── GET /api/federation/followers — Takipçiler listesi ─────────
router.get('/followers', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const follows = await Federation.findApFollows({ targetUserId: _u.id }) || [];
  const arr = Array.isArray(follows) ? follows : await follows;
  res.json(arr.map(f => ({
    actorUrl:  f.actorUrl,
    createdAt: f.createdAt,
  })));
}));

// ── POST /api/federation/like — Uzak notu beğen ───────────────
router.post('/like', authMiddleware, limits.federation(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { objectUrl } = req.body;
  if (!objectUrl) return res.status(400).json({ error: 'objectUrl required' });

  const user = await Users.findById(_u.id);
  if (!user?.apPrivateKey) return res.status(400).json({ error: 'ActivityPub key not set up. Follow someone first.' });

  const activity = await sendLike(user, objectUrl);
  res.json({ ok: true, activity });
}));

// ── DELETE /api/federation/like — Beğeniyi geri al ────────────
router.delete('/like', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { objectUrl } = req.body;
  if (!objectUrl) return res.status(400).json({ error: 'objectUrl required' });

  const user = await Users.findById(_u.id);
  if (!user) return res.status(401).json({ error: 'Not found' });

  const { deliverApActivity } = require('./delivery');
  const { v4: uuidv4 } = require('uuid');
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
}));

// ── POST /api/federation/announce — Boost / Reblog ────────────
router.post('/announce', authMiddleware, limits.federation(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { objectUrl } = req.body;
  if (!objectUrl) return res.status(400).json({ error: 'objectUrl required' });

  const user = await Users.findById(_u.id);
  if (!user?.apPrivateKey) return res.status(400).json({ error: 'ActivityPub key not set up.' });

  const activity = await sendAnnounce(user, objectUrl);
  res.json({ ok: true, activity });
}));

// ── GET /api/federation/timeline — Federated timeline ──────────
// Takip edilen uzak aktörlerin son postları (apMessages)
router.get('/timeline', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const page    = Math.max(1, parseInt(String(req.query.page ?? ''), 10) || 1);
  const limit   = Math.min(50, parseInt(String(req.query.limit ?? ''), 10) || 20);
  const skip    = (page - 1) * limit;

  // Kullanıcının takip ettiği uzak aktörleri bul
  const outgoing   = await Federation.findApOutgoingFollows({ fromUserId: _u.id, accepted: true }) || [];
  const arr        = Array.isArray(outgoing) ? outgoing : await outgoing;
  const actorUrls  = arr.map(f => f.targetActorUrl);

  if (!actorUrls.length) return res.json({ items: [], total: 0, page, limit });

  // Bu aktörlerden gelen mesajlar
  const q = { actorUrl: { $in: actorUrls } };
  let items = await Federation.apMessagesFind(q).sort({ published: -1 }).skip(skip).limit(limit) || [];
  if (!Array.isArray(items)) items = await items || [];

  const total = await Federation.countApMessages(q);

  res.json({ items, total, page, limit, pages: Math.ceil((total || 0) / limit) });
}));

// ── GET /api/federation/notifications — AP bildirimleri ────────
router.get('/notifications', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const limit = Math.min(50, parseInt(String(req.query.limit ?? ''), 10) || 20);
  const items = await Notifications.inboxFind({
    userId: _u.id,
    type:   { $in: ['ap_follow', 'ap_mention', 'ap_like', 'ap_announce'] },
  }).sort({ createdAt: -1 }).limit(limit) || [];

  res.json(Array.isArray(items) ? items : await items || []);
}));

// ── PATCH /api/federation/notifications/read-all ───────────────
router.patch('/notifications/read-all', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  await Notifications.updateInboxMany(
    { userId: _u.id, type: { $in: ['ap_follow', 'ap_mention', 'ap_like', 'ap_announce'] }, read: false },
    { $set: { read: true } },
    { multi: true }
  );
  res.json({ ok: true });
}));

// ── GET /api/federation/profile/:actorUrl — Uzak profil getir ──
router.get('/profile', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { actorUrl } = req.query;
  if (!actorUrl) return res.status(400).json({ error: 'actorUrl required' });

  try {
    const r = await fetch(actorUrl, {
      headers: { Accept: 'application/activity+json' },
      signal:  AbortSignal.timeout(8000),
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
  } catch (err) {
    res.status(502).json({ error: `Could not fetch actor: ${err.message}` });
  }
}));

module.exports = router;
export {};
