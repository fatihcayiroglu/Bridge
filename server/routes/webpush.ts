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
import { authMiddleware, requireAdmin} from '../middleware/auth';
import { v4 as uuidv4 } from 'uuid';
import { limits } from '../middleware/rateLimit';
import { sendPushToUser } from '../lib/pushSender';
import logger from '../lib/logger';
router.get('/vapid-public-key', (req, res) => {
  const key = process.env.VAPID_PUBLIC_KEY;
  if (!key) return res.status(503).json({ error: 'Web push not configured' });
  res.json({ publicKey: key });
});

// POST /api/webpush/subscribe
router.post('/subscribe', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const { endpoint, keys } = req.body as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
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
    }).catch((err: unknown) => {
      logger.error({ err, userId: _u.id, endpoint, event: 'webpush.subscribe.insert_failed' }, 'Failed to insert push subscription');
    });
  }
  res.json({ ok: true });
});

// DELETE /api/webpush/unsubscribe
router.delete('/unsubscribe', authMiddleware, limits.write(), async (req, res) => {
  const { endpoint } = req.body as Record<string, string>;
  if (endpoint) await Notifications.removePushSubscriptionWhere({ endpoint }, {});
  res.json({ ok: true });
});

// POST /api/webpush/test  — oturum açmış kullanıcıya test bildirimi gönderir
// Admin değil, kendi aboneliğini test etmek isteyen her kullanıcı kullanabilir.
router.post('/test', authMiddleware, limits.write(), async (req, res) => {
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
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
