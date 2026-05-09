// server/routes/webpush.js — Web Push VAPID
'use strict';

const express      = require('express');
const router       = express.Router();
const { Notifications } = require('../db/repositories');
const { authMiddleware, requireAdmin, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { v4: uuidv4 } = require('uuid');
const { limits }   = require('../middleware/rateLimit');
const { sendPushToUser } = require('../lib/pushSender');
const logger       = require('../lib/logger');

// GET /api/webpush/vapid-public-key  — auth gerekmez, SW tarafından çağrılır
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Web push not configured' });
  res.json({ publicKey: key });
});

// POST /api/webpush/subscribe
router.post('/subscribe', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    return res.status(400).json({ error: 'Invalid subscription' });
  }

  const existing = await Notifications.findPushSubscriptionByEndpoint(endpoint);
  if (existing) {
    await Notifications.updatePushSubscription(
      { endpoint },
      { $set: { userId: _u.id, updatedAt: Date.now() } }
    );
  } else {
    await Notifications.insertPushSubscription({
      _id: uuidv4(), userId: _u.id,
      endpoint, keys, createdAt: Date.now(),
    }).catch(() => {});
  }
  res.json({ ok: true });
}));

// DELETE /api/webpush/unsubscribe
router.delete('/unsubscribe', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const { endpoint } = req.body;
  if (endpoint) await Notifications.removePushSubscriptionWhere({ endpoint }, {});
  res.json({ ok: true });
}));

// POST /api/webpush/test  — oturum açmış kullanıcıya test bildirimi gönderir
// Admin değil, kendi aboneliğini test etmek isteyen her kullanıcı kullanabilir.
router.post('/test', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Web push not configured' });
  }

  const subs = await Notifications.findPushSubscriptionsForUser(_u.id);
  if (!subs || subs.length === 0) {
    return res.status(404).json({ error: 'No push subscription found for this user' });
  }

  await sendPushToUser(_u.id, {
    title: 'Bridge 🌉',
    body:  req.body?.message || 'Push bildirimleri çalışıyor!',
    tag:   'bridge-test',
    data:  { url: '/', type: 'test' },
  });

  logger.info(
    { userId: _u.id, subsCount: subs.length, event: 'webpush.test.sent' },
    'Test push sent'
  );
  res.json({ ok: true, sent: subs.length });
}));

module.exports = router;
export {};
