// server/routes/mobilePush.js
// Capacitor (iOS/Android) native push token kayıt endpoint'leri
// badge sıfırlama endpoint'i eklendi

'use strict';

const express = require('express');
const router  = express.Router();
const { Notifications } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { clearBadge }     = require('../lib/pushSender');
const { limits } = require('../middleware/rateLimit'); // rate limiting
const logger = require('../lib/logger');

// POST /api/mobile/push/register
router.post('/push/register', authMiddleware, limits.write(), async (req, res) => {
  try {
    const { token, platform } = req.body;
    const userId = req.user.id;
    if (!token || typeof token !== 'string')
      return res.status(400).json({ error: 'token is required' });
    if (!['ios', 'android'].includes(platform))
      return res.status(400).json({ error: 'platform must be ios or android' });
    await Notifications.upsertNativeToken(userId, platform, token);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, event: 'mobile.push.register.failed' }, 'Mobile push token registration failed.');
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/mobile/push/unregister
router.delete('/push/unregister', authMiddleware, limits.write(), async (req, res) => {
  try {
    const { platform } = req.body;
    await Notifications.removeNativeToken(req.user.id, platform);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/mobile/push/badge/clear
// Uygulama açıldığında badge sayacını sıfırla
router.post('/push/badge/clear', authMiddleware, limits.write(), async (req, res) => {
  try {
    await clearBadge(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/mobile/info
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
router.post('/push/register-native', authMiddleware, limits.write(), async (req, res) => {
  try {
    const { token, platform } = req.body;
    const userId = req.user.id;
    if (!token || typeof token !== 'string')
      return res.status(400).json({ error: 'token is required' });
    const plat = ['ios', 'android'].includes(platform) ? platform : 'unknown';
    await Notifications.upsertNativeToken(userId, plat, token);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err, event: 'mobile.push.register_native.failed' }, 'Native mobile push registration failed.');
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
export {};
