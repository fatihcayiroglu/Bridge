// server/routes/bots.ts — Session 18: @openapi annotation eklendi
// İlk 60 satır (import + token helper) değişmedi; annotation'lar eklendi.

import express from 'express';
import { normalizeMessageText, RAW_TEXT_FORMAT } from '../lib/storedText';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router   = express.Router();
import { Bots, Channels, ChannelWebhooks, Messages } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { botAuthMiddleware, type BotAuthedRequest } from '../middleware/botAuth';
import { limits } from '../middleware/rateLimit';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { normalizeContextCommands, normalizeSlashCommands, readPersistedCommandArray } from '../lib/botCommands';
import { replyToInvocation } from '../lib/botInteractionReply';
import type { HandlerServer } from '../socket/handler-contracts';
import { broadcastPersistedMessage, publishPersistedMessage } from '../lib/channelActivity';
function generateBotToken(_serverId: string, _botId: string): string {
  // The database stores only SHA-256(token), so a structured/HMAC token buys
  // nothing and historically introduced a dangerous known-secret fallback.
  // New credentials are high-entropy opaque bearer secrets; old tokens remain
  // valid because authentication is hash-based rather than format-signature based.
  return `brg_bot_${crypto.randomBytes(32).toString('base64url')}`;
}

function publicBotShape(bot: Record<string, unknown>) {
  const { tokenHash: _tokenHash, ...safe } = bot;
  return { ...safe, name: String(safe.username ?? '') };
}


// ── Bot-token self service + command discovery ──────────────────────────────

router.get('/me', botAuthMiddleware, async (req, res) => {
  const bot = (req as BotAuthedRequest).bot;
  res.json(publicBotShape(bot as unknown as Record<string, unknown>));
});

router.patch('/me/context-commands', botAuthMiddleware, limits.bots(), async (req, res) => {
  const bot = (req as BotAuthedRequest).bot;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  const commands = normalizeContextCommands(body.commands);
  if (!commands) return void res.status(400).json({ error: 'Invalid context commands' });
  await Bots.updateByIdAndServer(bot._id, bot.serverId, { contextCommands: commands });
  res.json({ commands });
});

router.patch('/me/slash-commands', botAuthMiddleware, limits.bots(), async (req, res) => {
  const bot = (req as BotAuthedRequest).bot;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  const commands = normalizeSlashCommands(body.commands);
  if (!commands) return void res.status(400).json({ error: 'Invalid slash commands' });
  await Bots.updateByIdAndServer(bot._id, bot.serverId, { slashCommands: commands });
  res.json({ commands });
});

// ── The bot action: answer an invocation (Final21 Phase 14) ────────────────
// Every authority check lives in lib/botInteractionReply.ts; this route only
// authenticates the bot and broadcasts the stored reply like any channel message.
router.post('/interactions/:messageId/reply', botAuthMiddleware, limits.bots(), async (req, res) => {
  const bot = (req as BotAuthedRequest).bot;
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body)
    ? req.body as Record<string, unknown> : {};
  const io = (req.app.get('io') as HandlerServer | undefined) ?? null;
  const result = await replyToInvocation(bot, String(req.params.messageId ?? ''), body.content, Date.now(), io);
  if (!result.ok) return void res.status(result.status).json({ error: result.error });
  // replyToInvocation already invalidated the history cache.
  broadcastPersistedMessage(io, result.message);
  res.json({ ok: true, message: result.message });
});

router.get('/commands', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = typeof req.query.serverId === 'string' ? req.query.serverId : '';
  if (!serverId) return void res.status(400).json({ error: 'serverId required' });
  const perms = await resolvePermissions(_u.id, serverId).catch(() => 0);
  if (!hasPermission(perms, PERMS.USE_BOT_COMMANDS)) {
    return void res.status(403).json({ error: 'No USE_BOT_COMMANDS permission' });
  }
  const bots = await Bots.findInstalledForServer(serverId);
  const commands: Record<string, unknown>[] = [];
  for (const bot of bots) {
    for (const command of readPersistedCommandArray(bot.slashCommands)) {
      const normalized = normalizeSlashCommands([command]);
      if (!normalized?.length) continue;
      commands.push({ ...normalized[0], botId: bot._id, botName: bot.username });
    }
  }
  res.json({ commands });
});

/**
 * @openapi
 * /servers/{serverId}/bots:
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
router.post('/:serverId/bots', authMiddleware, limits.bots(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const { name, description } = req.body as Record<string, string>;
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Bot name required' });
  }
  const normalizedName = name.trim();
  if (normalizedName.length > 100) {
    return res.status(400).json({ error: 'Bot name too long' });
  }

  const perms = await resolvePermissions(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'Bot oluşturmak için MANAGE_SERVER yetkisi gerekli' });
  }

  const botId = uuidv4();
  const token = generateBotToken(serverId, botId);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  const bot = await Bots.create({
    _id: botId, serverId, ownerId: _u.id, username: normalizedName,
    description: description || '', tokenHash, active: true,
  });
  // API compatibility: historical clients call this display field `name`; the
  // canonical PostgreSQL column remains `username` (single owner, no drift).
  const publicBot = bot ? publicBotShape(bot as unknown as Record<string, unknown>) : bot;
  res.status(201).json({ bot: publicBot, token, warning: 'This token will not be shown again.' });
});

// Publishing is the bot owner's decision: a marketplace listing can only be bound
// to a public bot, and nothing could set `isPublic` before (Final21 Phase 14), so
// no marketplace bot was ever installable through the product.
router.patch('/:serverId/bots/:botId', authMiddleware, limits.bots(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const botId = String(req.params.botId ?? '');
  const isPublic = (req.body as Record<string, unknown> | undefined)?.isPublic;
  if (typeof isPublic !== 'boolean') return res.status(400).json({ error: 'isPublic must be a boolean' });
  const perms = await resolvePermissions(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }
  const bot = await Bots.findByIdAndServer(botId, serverId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  await Bots.updateByIdAndServer(botId, serverId, { isPublic });
  const updated = await Bots.findByIdAndServer(botId, serverId);
  res.json(publicBotShape((updated ?? { ...bot, isPublic }) as unknown as Record<string, unknown>));
});

router.get('/:serverId/bots', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const perms = await resolvePermissions(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }
  const bots = await Bots.findByServer(serverId);
  res.json(bots.map((bot) => publicBotShape(bot as unknown as Record<string, unknown>)));
});

/**
 * @openapi
 * /servers/{serverId}/bots/{botId}:
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
router.delete('/:serverId/bots/:botId', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const botId = String(req.params.botId ?? '');
  const perms = await resolvePermissions(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }
  const bot = await Bots.findByIdAndServer(botId, serverId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  await Bots.delete(botId, serverId);
  res.json({ ok: true, deleted: true });
});

/**
 * @openapi
 * /servers/{serverId}/bots/{botId}/token:
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
router.post('/:serverId/bots/:botId/token', authMiddleware, limits.bots(), async (req, res) => {
  const _u = castAuthed(req).user;
  const serverId = String(req.params.serverId ?? '');
  const botId = String(req.params.botId ?? '');
  const perms = await resolvePermissions(_u.id, serverId);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER) && !hasPermission(perms, PERMS.ADMIN)) {
    return res.status(403).json({ error: 'No permission' });
  }
  const bot = await Bots.findByIdAndServer(botId, serverId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  const token = generateBotToken(serverId, botId);
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  await Bots.updateToken(botId, serverId, tokenHash);
  res.json({ token, warning: 'Previous token is no longer valid.' });
});

/**
 * @openapi
 * /webhooks/{webhookId}:
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
const receiveWebhook = async (req: express.Request, res: express.Response): Promise<void> => {
  const webhookId = String(req.params.webhookId ?? '');
  const { content, embeds } = (req.body ?? {}) as { content?: unknown; embeds?: unknown };
  const hasContent = typeof content === 'string' && content.length > 0;
  const hasEmbeds = Array.isArray(embeds) && embeds.length > 0;

  if (typeof content === 'string' && content.length > 2000) {
    res.status(400).json({ error: 'Message too long' });
    return;
  }
  if (!hasContent && !hasEmbeds) {
    res.status(400).json({ error: 'content veya embeds gerekli' });
    return;
  }

  const rawToken = req.query.token;
  const providedToken = Array.isArray(rawToken) ? rawToken[0] : rawToken;
  if (typeof providedToken !== 'string' || !providedToken) {
    res.status(401).json({ error: 'Webhook token gerekli' });
    return;
  }

  // Yerinde daraltma sema ile HIZALI olmalidir. `webhooks` tablosunda
  // `name TEXT NOT NULL` ve `"avatarUrl" TEXT` SUTUNLARI VAR; bu daraltma
  // onlari atliyordu, dolayisiyla asagidaki `webhook.name` / `webhook.avatarUrl`
  // okumalari derleme hatasi veriyordu (calisma aninda degerler mevcuttu).
  const webhook = await ChannelWebhooks.findById(webhookId) as {
    _id: string;
    channelId?: string;
    createdBy?: string;
    token?: string;
    name?: string;
    avatarUrl?: string | null;
  } | null;
  if (!webhook) {
    res.status(404).json({ error: 'Webhook bulunamadı' });
    return;
  }

  let validToken: boolean;
  try {
    validToken = crypto.timingSafeEqual(
      Buffer.from(webhook.token || ''),
      Buffer.from(providedToken),
    );
  } catch {
    validToken = false;
  }
  if (!validToken) {
    res.status(401).json({ error: 'Geçersiz webhook token' });
    return;
  }

  if (typeof webhook.channelId !== 'string') {
    res.status(400).json({ error: 'Webhook kanal bilgisi eksik' });
    return;
  }
  const channel = await Channels.findById(webhook.channelId);
  if (!channel) {
    res.status(404).json({ error: 'Kanal bulunamadı' });
    return;
  }

  const message = await Messages.create({
    _id: uuidv4(),
    channelId: webhook.channelId,
    serverId: channel.serverId,
    // Webhooks are not users. Keep the message identity scoped to the webhook
    // instead of impersonating the account that originally created it.
    userId: `webhook:${webhook._id}`,
    username: webhook.name || 'Webhook',
    displayName: webhook.name || 'Webhook',
    avatarColor: '#2d9cdb',
    avatarUrl: webhook.avatarUrl || null,
    content: hasContent ? normalizeMessageText(content) : '',
    contentFormat: RAW_TEXT_FORMAT,
    embeds: hasEmbeds ? embeds : undefined,
    reactions: {},
    webhookId: webhook._id,
    isWebhook: true,
    createdAt: Date.now(),
  });
  // Final21 Phase 15: webhook posts were stored but never delivered — nobody in the
  // channel saw them until a reload, and the cached first page hid them even then.
  await publishPersistedMessage((req.app.get('io') as HandlerServer | undefined) ?? null, message);
  res.json({ ok: true });
};

router.post('/webhooks/:webhookId', limits.bots(), receiveWebhook);
// Legacy alias POST /api/webhooks/:webhookId. This router is ALSO mounted at /servers, /bot
// and /bots (app/setupRoutes.ts), where a bare `/:webhookId` swallowed unrelated POSTs from
// routers mounted later — `POST /api/bots/marketplace` (listing submission) was answered by
// this receiver with 400 (Final21 Phase 14, live probe). Only the /webhooks mount owns it.
router.post('/:webhookId', (req, _res, next) => {
  if (/\/webhooks$/.test(req.baseUrl)) next();
  else next('router');
}, limits.bots(), receiveWebhook);

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
