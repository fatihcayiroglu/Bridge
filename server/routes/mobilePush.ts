// server/routes/mobilePush.ts
// Capacitor (iOS/Android) native push token kayıt endpoint'leri
// badge sıfırlama endpoint'i eklendi


import express from 'express';
const router  = express.Router();
import { Notifications } from '../db/repositories';
import { authMiddleware } from '../middleware/auth';
import { clearBadge } from '../lib/pushSender';
import { limits } from '../middleware/rateLimit';
// POST /api/mobile/push/register
/**
 * @openapi
 * /mobile/push/register:
 *   post:
 *     tags: [Mobile]
 *     summary: Push token kaydet
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, platform]
 *             properties:
 *               token:    { type: string }
 *               platform: { type: string, enum: [ios, android] }
 *     responses:
 *       200: { description: Token kaydedildi }
 *       400: { description: Geçersiz token veya platform }
 */
router.post('/push/register', authMiddleware, limits.write(), async (req, res) => {
  const { token, platform } = req.body as Record<string, string>;
  const userId = req.user.id;
  if (!token || typeof token !== 'string')
    return res.status(400).json({ error: 'token is required' });
  if (!['ios', 'android'].includes(platform))
    return res.status(400).json({ error: 'platform must be ios or android' });
  await Notifications.upsertNativeToken(userId, platform, token);
  res.json({ ok: true });
});

// DELETE /api/mobile/push/unregister
/**
 * @openapi
 * /mobile/push/unregister:
 *   delete:
 *     tags: [Mobile]
 *     summary: Push token kaldır
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Token kaldırıldı }
 *       404: { description: Token bulunamadı }
 */
router.delete('/push/unregister', authMiddleware, limits.write(), async (req, res) => {
  const { platform } = req.body as Record<string, string>;
  await Notifications.removeNativeToken(req.user.id, platform);
  res.json({ ok: true });
});

// POST /api/mobile/push/badge/clear
// Uygulama açıldığında badge sayacını sıfırla
/**
 * @openapi
 * /mobile/push/badge/clear:
 *   post:
 *     tags: [Mobile]
 *     summary: iOS badge sayacını sıfırla
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Badge sıfırlandı }
 */
router.post('/push/badge/clear', authMiddleware, limits.write(), async (req, res) => {
  await clearBadge(req.user.id);
  res.json({ ok: true });
});

// GET /api/mobile/info
/**
 * @openapi
 * /mobile/info:
 *   get:
 *     tags: [Mobile]
 *     summary: Uygulama sürüm ve push yapılandırma bilgisi
 *     responses:
 *       200:
 *         description: Uygulama metadata
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 pushEnabled: { type: boolean }
 *                 minVersion:  { type: string }
 */
router.get('/info', (req, res) => {
  res.json({
    serverVersion: '50.0.0',
    minAppVersion: '1.0.0',
    platform: 'bridge',
    features: {
      e2ee: true,
      voiceE2ee: true,
      federation: true,
      ai: !!process.env.GROQ_API_KEY || !!process.env.GEMINI_API_KEY,
    },
  });
});

// POST /push/register-native
// Capacitor bridge (mobile/capacitor-bridge.js) bu URL'yi kullanır — uyumluluk alias'ı.
// /push/register ile aynı mantık fakat platform alanı opsiyonel.
/**
 * @openapi
 * /mobile/push/register-native:
 *   post:
 *     tags: [Mobile]
 *     summary: Native push token kaydet (APNs / FCM doğrudan)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, platform]
 *             properties:
 *               token:    { type: string }
 *               platform: { type: string, enum: [ios, android] }
 *               bundleId: { type: string }
 *     responses:
 *       200: { description: Native token kaydedildi }
 */
router.post('/push/register-native', authMiddleware, limits.write(), async (req, res) => {
  const { token, platform } = req.body as Record<string, string>;
  const userId = req.user.id;
  if (!token || typeof token !== 'string')
    return res.status(400).json({ error: 'token is required' });
  const plat = ['ios', 'android'].includes(platform) ? platform : 'unknown';
  await Notifications.upsertNativeToken(userId, plat, token);
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
