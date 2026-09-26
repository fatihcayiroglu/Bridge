/**
 * @openapi
 * tags:
 *   - name: WebPush
 *     description: WebPush API endpoints

 *
 * /webpush/subscribe:
 *   post:
 *     tags: [Bots]
 *     summary: Web push bildirim aboneliği kaydet
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [subscription]
 *             properties:
 *               subscription: { type: object, description: 'PushSubscription objesi' }
 *     responses:
 *       200:
 *         description: Abonelik kaydedildi
 *
 * /webpush/unsubscribe:
 *   post:
 *     tags: [Bots]
 *     summary: Web push aboneliğini iptal et
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [endpoint]
 *             properties:
 *               endpoint: { type: string, format: uri }
 *     responses:
 *       200:
 *         description: Abonelik iptal edildi
 *
 * /webpush/vapid-public-key:
 *   get:
 *     tags: [Bots]
 *     summary: VAPID public key (Web Push için)
 *     security: []
 *     responses:
 *       200:
 *         description: VAPID public key
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 publicKey: { type: string }
 *
 * /webpush/test:
 *   post:
 *     tags: [Bots]
 *     summary: Test push bildirimi gönder
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Test bildirimi gönderildi
 */

// server/routes/webpush.ts — Web Push VAPID

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router       = express.Router();
import { Notifications } from '../db/repositories';
import { authMiddleware } from '../middleware/auth';
import { v4 as uuidv4 } from 'uuid';
import { limits } from '../middleware/rateLimit';
import { sendPushToUser } from '../lib/pushSender';
import { validateWebPushSubscription } from '../lib/webPushSubscriptionPolicy';
import logger from '../lib/logger';
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Web push not configured' });
  res.json({ publicKey: key });
});

// POST /api/webpush/subscribe
router.post('/subscribe', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const validated = validateWebPushSubscription(req.body);
  if (!validated.ok) return res.status(400).json({ error: validated.error });
  const { endpoint, keys } = validated.subscription;

  try {
    // A PushSubscription is origin/browser scoped. On a shared browser an
    // account switch must be able to move the SAME subscription away from the
    // previous account, otherwise the previous account's private pushes could
    // appear in the new session. Endpoint possession alone is not enough,
    // though: require the persisted subscription keys to match before transfer.
    const existingOwned = await Notifications.findPushSubscriptionForUserEndpoint(_u.id, endpoint);
    if (existingOwned) {
      await Notifications.updatePushSubscription(
        { userId: _u.id, endpoint },
        { $set: { keys, updatedAt: Date.now() } }
      );
    } else {
      const existingEndpoint = await Notifications.findPushSubscriptionByEndpoint(endpoint);
      if (existingEndpoint) {
        const persistedKeys = (existingEndpoint as { keys?: { p256dh?: unknown; auth?: unknown } }).keys;
        const sameSubscription = persistedKeys?.p256dh === keys.p256dh && persistedKeys?.auth === keys.auth;
        if (!sameSubscription) {
          return res.status(409).json({ error: 'Push subscription is already registered' });
        }
        await Notifications.updatePushSubscription(
          { endpoint },
          { $set: { userId: _u.id, keys, updatedAt: Date.now() } }
        );
      } else {
        await Notifications.insertPushSubscription({
          _id: uuidv4(), userId: _u.id,
          endpoint, keys, createdAt: Date.now(),
        });
      }
    }
  } catch (err) {
    logger.error({ err, userId: _u.id, endpoint, event: 'webpush.subscribe.storage_failed' }, 'Failed to persist push subscription');
    return res.status(503).json({ error: 'Push subscription storage unavailable' });
  }
  res.json({ ok: true });
});

// DELETE /api/webpush/unsubscribe
router.delete('/unsubscribe', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const { endpoint } = req.body as Record<string, string>;
  // GÜVENLİK: abonelik ÇAĞIRANA ait olmalı.
  //
  // Eskiden silme YALNIZCA `endpoint` ile yapılıyordu ve `endpoint` sütunu
  // TÜM kullanıcılar arasında UNIQUE'tir. Yani başka bir kullanıcının push
  // endpoint'ini ele geçiren (paylaşılan cihaz, log, istemci depolaması)
  // kimliği doğrulanmış herhangi biri, o kullanıcının aboneliğini sessizce
  // silip bildirimlerini kesebiliyordu. Kimlik yuvalanması aidiyet
  // kanıtlamaz — kapsam açıkça `userId` ile daraltılır.
  if (endpoint) {
    try {
      await Notifications.removePushSubscriptionWhere({ endpoint, userId: _u.id }, {});
    } catch (err) {
      logger.error({ err, userId: _u.id, endpoint, event: 'webpush.unsubscribe.storage_failed' }, 'Failed to remove push subscription');
      return res.status(503).json({ error: 'Push subscription storage unavailable' });
    }
  }
  res.json({ ok: true });
});

// POST /api/webpush/test  — oturum açmış kullanıcıya test bildirimi gönderir
// Admin değil, kendi aboneliğini test etmek isteyen her kullanıcı kullanabilir.
router.post('/test', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    return res.status(503).json({ error: 'Web push not configured' });
  }

  let subs;
  try {
    subs = await Notifications.findPushSubscriptionsForUser(_u.id);
  } catch (err) {
    logger.error({ err, userId: _u.id, event: 'webpush.test.storage_failed' }, 'Failed to read push subscriptions');
    return res.status(503).json({ error: 'Push subscription storage unavailable' });
  }
  if (!subs || subs.length === 0) {
    return res.status(404).json({ error: 'No push subscription found for this user' });
  }

  await sendPushToUser(_u.id, {
    title: 'Bridge 🌉',
    body:  typeof req.body?.message === 'string'
      ? req.body.message.slice(0, 200)
      : 'Push bildirimleri çalışıyor!',
    tag:   'bridge-test',
    data:  { url: '/', type: 'test' },
  });

  logger.info(
    { userId: _u.id, subsCount: subs.length, event: 'webpush.test.sent' },
    'Test push sent'
  );
  res.json({ ok: true, sent: subs.length });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
