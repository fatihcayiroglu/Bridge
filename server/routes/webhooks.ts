// server/routes/webhooks.ts — Session 18: @openapi annotation eklendi

import express from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router       = express.Router({ mergeParams: true });
import { Channels, ChannelWebhooks } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { limits } from '../middleware/rateLimit';

/**
 * @openapi
 * /channels/{channelId}/webhooks:
 *   get:
 *     summary: Kanalın webhook'larını listele
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Webhook listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Webhook'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *   post:
 *     summary: Yeni webhook oluştur
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:
 *                 type: string
 *                 example: My Webhook
 *               avatar:
 *                 type: string
 *                 description: Avatar URL (opsiyonel)
 *     responses:
 *       201:
 *         description: Webhook oluşturuldu
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Webhook'
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       429:
 *         $ref: '#/components/responses/TooManyRequests'
 */
router.get('/', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const channelId = String(req.params.channelId ?? '');

  const channel = await Channels.findById(channelId);
  if (!channel) return res.status(404).json({ error: 'Kanal bulunamadı' });

  const perms = await resolvePermissions(_u.id, channel.serverId, channelId);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.MANAGE_WEBHOOKS)) {
    return res.status(403).json({ error: 'MANAGE_WEBHOOKS yetkisi gerekli' });
  }

  const webhooks = await ChannelWebhooks.findByChannel(channelId);
  res.json(webhooks.map(({ token: _token, ...safe }) => safe));
});

router.post('/', authMiddleware, limits.webhooks(), async (req, res) => {
  const _u = castAuthed(req).user;
  const channelId = String(req.params.channelId ?? '');
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? req.body as Record<string, unknown>
    : {};
  const name = body.name;
  const avatar = body.avatar;

  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) {
    return res.status(400).json({ error: 'name 1-100 karakter olmalı' });
  }
  if (avatar !== undefined && avatar !== null && (typeof avatar !== 'string' || avatar.length > 2048)) {
    return res.status(400).json({ error: 'avatar geçersiz' });
  }

  const channel = await Channels.findById(channelId);
  if (!channel) return res.status(404).json({ error: 'Kanal bulunamadı' });

  const perms = await resolvePermissions(_u.id, channel.serverId, channelId);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.MANAGE_WEBHOOKS)) {
    return res.status(403).json({ error: 'MANAGE_WEBHOOKS yetkisi gerekli' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  const webhook = await ChannelWebhooks.create({
    _id: uuidv4(),
    channelId,
    serverId: channel.serverId,
    name: name.trim(),
    avatarUrl: typeof avatar === 'string' && avatar ? avatar : null,
    token,
    createdBy: _u.id,
    // NOT NULL in PostgreSQL. Missing since the route was written: every webhook
    // creation failed with 500 (Final21 Phase 15, live probe; the mock DB accepted it).
    createdAt: Date.now(),
  });

  // The token is a bearer capability and is intentionally disclosed exactly at
  // creation time. Never let browsers/proxies cache that one-time secret.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.status(201).json(webhook);
});

/**
 * @openapi
 * /channels/{channelId}/webhooks/{webhookId}:
 *   delete:
 *     summary: Webhook'u sil
 *     tags: [Webhooks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: webhookId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Webhook silindi
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         description: Webhook bulunamadı
 */
router.delete('/:webhookId', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const channelId = String(req.params.channelId ?? '');
  const webhookId = String(req.params.webhookId ?? '');

  const channel = await Channels.findById(channelId);
  if (!channel) return res.status(404).json({ error: 'Kanal bulunamadı' });

  const perms = await resolvePermissions(_u.id, channel.serverId, channelId);
  if (!hasPermission(perms, PERMS.VIEW_CHANNELS) || !hasPermission(perms, PERMS.MANAGE_WEBHOOKS)) {
    return res.status(403).json({ error: 'No permission' });
  }

  const webhook = await ChannelWebhooks.findById(webhookId) as { channelId?: string } | null;
  if (!webhook || webhook.channelId !== channelId) {
    return res.status(404).json({ error: 'Webhook not found' });
  }

  await ChannelWebhooks.delete(webhookId, channelId);
  res.json({ ok: true });
});

/**
 * @openapi
 * /channels/{channelId}/webhooks/{webhookId}:
 *   get:
 *     summary: Webhook bilgisini getir (token ile kimlik doğrulama)
 *     tags: [Webhooks]
 *     parameters:
 *       - in: path
 *         name: channelId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: webhookId
 *         required: true
 *         schema:
 *           type: string
 *       - in: query
 *         name: token
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Webhook bilgisi
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Webhook'
 *       401:
 *         description: Geçersiz token
 */
router.get('/:webhookId', async (req, res) => {
  const params = req.params as Record<string, string | undefined>;
  const channelId = String(params.channelId ?? '');
  const webhookId = String(params.webhookId ?? '');
  const { token } = req.query;

  const webhook = await ChannelWebhooks.findById(webhookId) as ({ token?: string; channelId?: string } & Record<string, unknown>) | null;
  if (!webhook || String(webhook.channelId ?? '') !== channelId) {
    return res.status(401).json({ error: 'Geçersiz webhook veya token' });
  }
  
  // SECURITY: Use timing-safe comparison to prevent token brute-force attacks
  let isValid = false;
  if (webhook && token) {
    try {
      // Ensure both are buffers for timing-safe comparison
      const providedToken = Array.isArray(token) ? token[0] : token;
      const providedTokenString = typeof providedToken === 'string' ? providedToken : '';
      isValid = crypto.timingSafeEqual(
        Buffer.from(webhook.token || ''),
        Buffer.from(providedTokenString)
      );
    } catch {
      // timingSafeEqual throws if lengths differ; treat as invalid
      isValid = false;
    }
  }

  if (!isValid) {
    return res.status(401).json({ error: 'Geçersiz webhook veya token' });
  }

  const { token: _t, ...safe } = webhook;
  // This endpoint is capability-authenticated; keep token-bearing request URLs
  // and their metadata out of intermediary/browser caches.
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.json(safe);
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
