// server/routes/bots.ts — Session 18: @openapi annotation eklendi
// İlk 60 satır (import + token helper) değişmedi; annotation'lar eklendi.

import express from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router   = express.Router();
import { Bots, Members, Channels, Messages } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
function generateBotToken(serverId: string, botId: string): string {
  const secret = process.env.BOT_TOKEN_SECRET || process.env.JWT_SECRET || 'bridge-bot-secret';
  const payload = Buffer.from(`${serverId}:${botId}:${Date.now()}`).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 16);
  return `brg_bot_${payload}.${sig}`;
}

/**
 * @openapi
 * /api/servers/{serverId}/bots:
 *   post:
 *     summary: Yeni bot oluştur
 *     tags: [Bots]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
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
 *                 example: my-helper-bot
 *               description:
 *                 type: string
 *     responses:
 *       201:
 *         description: Bot oluşturuldu
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 bot:
 *                   $ref: '#/components/schemas/Bot'
 *                 token:
 *                   type: string
 *                   description: İlk token (bir kez gösterilir)
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       429:
 *         $ref: '#/components/responses/TooManyRequests'
 *   get:
 *     summary: Sunucu botlarını listele
 *     tags: [Bots]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Bot listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Bot'
 */
/**
 * @openapi
 * /servers/{serverId}/bots:
 *   post:
 *     tags: [Bots]
 *     summary: Bot oluştur / API anahtarı al
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string }
 *               description: { type: string }
 *     responses:
 *       201:
 *         description: Bot oluşturuldu
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 botId: { type: string }
 *                 apiKey: { type: string }
 */
router.post('/:serverId/bots', authMiddleware, limits.bots(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const { name, description } = req.body as Record<string, string>;

  const perms = await resolvePermissions(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'Bot oluşturmak için MANAGE_SERVER yetkisi gerekli' });
  }

  const botId = uuidv4();
  const token = generateBotToken(serverId, botId);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const bot = await Bots.create({ _id: botId, serverId, name, description, tokenHash, createdBy: _u.id });
  res.status(201).json({ bot, token });
});

/**
 * @openapi
 * /servers/{serverId}/bots:
 *   get:
 *     tags: [Bots]
 *     summary: Sunucu botları listele
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Bot listesi
 *         content:
 *           application/json:
 *             schema: { type: array, items: { type: object } }
 */
router.get('/:serverId/bots', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const perms = await resolvePermissions(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }
  const bots = await Bots.findByServer(serverId);
  res.json(bots);
});

/**
 * @openapi
 * /api/servers/{serverId}/bots/{botId}:
 *   delete:
 *     summary: Botu sil
 *     tags: [Bots]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: botId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Bot silindi
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 *       404:
 *         description: Bot bulunamadı
 */
/**
 * @openapi
 * /servers/{serverId}/bots/{botId}:
 *   delete:
 *     tags: [Bots]
 *     summary: Botu sil
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: botId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Bot silindi }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.delete('/:serverId/bots/:botId', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const botId = String(req.params.botId ?? '');
  const perms = await resolvePermissions(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }
  await Bots.delete(botId, serverId);
  res.json({ ok: true });
});

/**
 * @openapi
 * /api/servers/{serverId}/bots/{botId}/token:
 *   post:
 *     summary: Bot token'ını yenile
 *     tags: [Bots]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema:
 *           type: string
 *       - in: path
 *         name: botId
 *         required: true
 *         schema:
 *           type: string
 *     responses:
 *       200:
 *         description: Yeni token (bir kez gösterilir)
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *       403:
 *         $ref: '#/components/responses/Forbidden'
 */
/**
 * @openapi
 * /servers/{serverId}/bots/{botId}/token:
 *   post:
 *     tags: [Bots]
 *     summary: Bot API anahtarını yenile
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: botId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Yeni API anahtarı
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 apiKey: { type: string }
 */
router.post('/:serverId/bots/:botId/token', authMiddleware, limits.bots(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const botId = String(req.params.botId ?? '');
  const perms = await resolvePermissions(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }
  const token = generateBotToken(serverId, botId);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await Bots.updateToken(botId, serverId, tokenHash);
  res.json({ token });
});

/**
 * @openapi
 * /api/webhooks/{webhookId}:
 *   post:
 *     summary: Webhook endpoint (dış servisler için)
 *     tags: [Bots]
 *     parameters:
 *       - in: path
 *         name: webhookId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               content:
 *                 type: string
 *               embeds:
 *                 type: array
 *     responses:
 *       200:
 *         description: Mesaj gönderildi
 *       401:
 *         description: Geçersiz webhook ID
 *       400:
 *         description: Geçersiz içerik
 */
/**
 * @openapi
 * /bot/webhooks/{webhookId}:
 *   post:
 *     tags: [Bots]
 *     summary: Webhook tetikle (bot → Bridge)
 *     security: []
 *     parameters:
 *       - in: path
 *         name: webhookId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               content: { type: string }
 *               username: { type: string }
 *               embeds: { type: array, items: { type: object } }
 *     responses:
 *       200: { description: Mesaj gönderildi }
 *       401: { description: Geçersiz webhook ID }
 */
router.post('/webhooks/:webhookId', limits.bots(), async (req, res) => {
  const webhookId = String(req.params.webhookId ?? '');
  const { content, embeds } = req.body as { content?: string; embeds?: unknown[] };
  if (!content && !embeds?.length) return res.status(400).json({ error: 'content veya embeds gerekli' });

  const bot = await Bots.findByWebhookId(webhookId);
  if (!bot) return res.status(401).json({ error: 'Geçersiz webhook' });

  if (typeof bot.channelId !== 'string') return res.status(400).json({ error: 'Bot kanal bilgisi eksik' });
  const channel = await Channels.findById(bot.channelId);
  if (!channel) return res.status(404).json({ error: 'Kanal bulunamadı' });

  await Messages.create({ channelId: bot.channelId, authorId: bot._id, content: content || '', embeds, isBot: true });
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
