// server/routes/bots.js
// Bot & API token sistemi
// - Bot hesabı oluşturma (server owner)
// - Token tabanlı kimlik doğrulama
// - Webhook event sistemi
// - Slash komut kaydı
//
// ENDPOINTS:
//   POST   /api/servers/:sid/bots           — yeni bot oluştur
//   GET    /api/servers/:sid/bots           — sunucu botlarını listele
//   DELETE /api/servers/:sid/bots/:botId    — bot sil
//   POST   /api/servers/:sid/bots/:botId/token — token yenile
//   POST   /api/webhooks/:webhookId         — webhook endpoint (dış servisler)

const express  = require('express');
const crypto   = require('crypto');
const { v4: uuidv4 } = require('uuid');
const router   = express.Router();
const { Bots, Members, Channels, Messages } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { limits } = require('../middleware/rateLimit'); // rate limiting
const { resolvePermissions, hasPermission, PERMS } = require('../lib/permissions');
const asyncHandler = require('../middleware/asyncHandler');

// ── TOKEN ÜRETİMİ ─────────────────────────────────────────────
// Format: brg_bot_<base64(serverId:botId:timestamp)>.<hmac>
function generateBotToken(serverId, botId) {
  const secret = process.env.BOT_TOKEN_SECRET || process.env.JWT_SECRET || 'bridge-bot-secret';
  const payload = Buffer.from(`${serverId}:${botId}:${Date.now()}`).toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 16);
  return `brg_bot_${payload}.${sig}`;
}

function verifyBotToken(token) {
  try {
    if (!token?.startsWith('brg_bot_')) return null;
    const [payload, sig] = token.slice(8).split('.');
    const secret = process.env.BOT_TOKEN_SECRET || process.env.JWT_SECRET || 'bridge-bot-secret';
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url').slice(0, 16);
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const [serverId, botId] = Buffer.from(payload, 'base64url').toString().split(':');
    return { serverId, botId };
  } catch { return null; }
}

// ── BOT AUTH MİDDLEWARE ───────────────────────────────────────
async function botAuthMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bot ')) return res.status(401).json({ error: 'Bot token required (Authorization: Bot <token>)' });

  const token = header.slice(4);
  const decoded = verifyBotToken(token);
  if (!decoded) return res.status(401).json({ error: 'Invalid bot token' });

  const bot = await Bots.findByIdAndToken(decoded.botId, decoded.serverId, hashToken(token));
  if (!bot || !bot.active) return res.status(401).json({ error: 'Bot not found or deactivated' });

  req.bot = bot;
  req.user = { id: bot._id, username: bot.username, isBot: true };
  next();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// ── ROUTES ───────────────────────────────────────────────────

// POST /api/servers/:sid/bots
router.post('/:sid/bots', authMiddleware, limits.bots(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Bot name required' });

  const botId = uuidv4();
  const token = generateBotToken(req.params.sid, botId);

  const bot = await Bots.insert({
    _id:         botId,
    serverId:    req.params.sid,
    ownerId:     _u.id,
    username:    name.trim().slice(0, 32),
    description: (description || '').slice(0, 200),
    tokenHash:   hashToken(token),
    active:      true,
    permissions: PERMS.SEND_MESSAGES | PERMS.READ_HISTORY | PERMS.EMBED_LINKS,
    webhookUrl:  null,
    events:      [],
    createdAt:   Date.now(),
  });

  // Token sadece bu yanıtta gösterilir — bir daha gösterilmez
  res.json({ ...bot, token, warning: 'Save this token — it will not be shown again.' });
}));

// GET /api/servers/:sid/bots
router.get('/:sid/bots', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const membership = await Members.findOne(_u.id, req.params.sid);
  if (!membership) return res.status(403).json({ error: 'Not a member' });
  const bots = await Bots.findByServer(req.params.sid);
  res.json(bots.map(b => ({ ...b, tokenHash: undefined }))); // hash'i gizle
}));

// DELETE /api/servers/:sid/bots/:botId
router.delete('/:sid/bots/:botId', authMiddleware, limits.bots(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  await Bots.deactivate(req.params.botId, req.params.sid);
  res.json({ deleted: true });
}));

// POST /api/servers/:sid/bots/:botId/token — token yenile
router.post('/:sid/bots/:botId/token', authMiddleware, limits.bots(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const newToken = generateBotToken(req.params.sid, req.params.botId);
  await Bots.updateByIdAndServer(req.params.botId, req.params.sid, {
    tokenHash: hashToken(newToken),
    tokenRotatedAt: Date.now(),
  });
  res.json({ token: newToken, warning: 'Previous token is now invalid.' });
}));

// ── BOT MESSAGE API ──────────────────────────────────────────
// POST /api/bot/channels/:channelId/messages
router.post('/channels/:channelId/messages', botAuthMiddleware, asyncHandler(async (req, res) => {
  const { content, embeds } = req.body;
  if (!content?.trim() && !embeds?.length)
    return res.status(400).json({ error: 'content or embeds required' });

  const channel = await Channels.findByIdAndServer(req.params.channelId, req.bot.serverId);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const { v4: uuidv4 } = require('uuid');
  const io = req.app.get('io');

  const msg = await Messages.create({
    _id:         uuidv4(),
    channelId:   req.params.channelId,
    serverId:    req.bot.serverId,
    userId:      req.bot._id,
    username:    req.bot.username,
    displayName: req.bot.username + ' [BOT]',
    avatarColor: '#5865f2',
    content:     (content || '').trim().slice(0, 2000),
    embeds:      embeds || [],
    type:        'bot',
    reactions:   {},
    createdAt:   Date.now(),
    isBot:       true,
  });

  if (io) io.to(`channel:${req.params.channelId}`).emit('message:new', msg);
  res.json(msg);
}));

// ── WEBHOOK ENDPOINT ─────────────────────────────────────────
// POST /api/webhooks/:webhookId?token=...
// Dış servisler (GitHub, Stripe vs.) buraya POST atar
router.post('/webhooks/:webhookId', asyncHandler(async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(401).json({ error: 'token query param required' });

  const webhook = await Bots.findIncomingWebhook(req.params.webhookId);
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  // token, webhook oluşturulurken üretilen HMAC değeridir
  if (!webhook.token || webhook.token.length !== token.length) return res.status(403).json({ error: 'Invalid token' });
  const expected = Buffer.from(webhook.token);
  const provided = Buffer.from(token);
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided))
    return res.status(403).json({ error: 'Invalid token' });

  const { content, username, embeds } = req.body;
  const io = req.app.get('io');
  const { v4: uuidv4 } = require('uuid');

  const msg = await Messages.create({
    _id: uuidv4(), channelId: webhook.channelId, serverId: webhook.serverId,
    userId: 'webhook', username: (username || webhook.name).slice(0, 32),
    displayName: (username || webhook.name).slice(0, 32) + ' [Webhook]',
    avatarColor: '#eb459e', content: (content || '').slice(0, 2000),
    embeds: embeds || [], type: 'webhook', reactions: {}, createdAt: Date.now(), isBot: true,
  });

  if (io) io.to(`channel:${webhook.channelId}`).emit('message:new', msg);
  res.json({ id: msg._id });
}));

// ── v38: Context menu komut kaydı ─────────────────────────────
// PATCH /api/bots/me/context-commands — botun context menu komutlarını kaydet
router.patch('/me/context-commands', botAuthMiddleware, asyncHandler(async (req, res) => {
  const bot = await Bots.findById(req.bot._id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });

  const commands = req.body.commands;
  if (!Array.isArray(commands)) return res.status(400).json({ error: 'commands must be array' });

  const VALID_CMD_TYPES = ['USER_COMMAND', 'MESSAGE_COMMAND'];
  const cleaned = commands.slice(0, 20).map(c => ({
    name:        String(c.name || '').trim().slice(0, 32),
    type:        VALID_CMD_TYPES.includes(c.type) ? c.type : 'MESSAGE_COMMAND',
    description: String(c.description || '').slice(0, 100),
  })).filter(c => c.name);

  await Bots.update(bot._id, { contextCommands: JSON.stringify(cleaned) });
  res.json({ ok: true, commands: cleaned });
}));

// GET /api/bots/me/context-commands
router.get('/me/context-commands', botAuthMiddleware, asyncHandler(async (req, res) => {
  const bot = await Bots.findById(req.bot._id);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  res.json(JSON.parse(bot.contextCommands || '[]'));
}));

// GET /api/bots/commands?serverId=xxx — Slash autocomplete için sunucudaki bot komutları
// Client slash.js tarafından kullanılır
router.get('/commands', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId } = req.query;
  if (!serverId) return res.status(400).json({ error: 'serverId gerekli' });

  // Üyelik kontrolü
  const member = await Members.findOne(_u.id, serverId);
  if (!member) return res.status(403).json({ error: 'Bu sunucuda değilsin' });

  // Sunucudaki botları bul
  const serverBots = await Bots.findServerBots(serverId);
  if (!serverBots.length) return res.json({ commands: [] });

  const botIds = serverBots.map(sb => sb.botId);
  const bots   = await Bots.findByIds(botIds);

  // Her botun komutlarını topla
  const commands: any[] = [];
  for (const bot of bots) {
    if (!bot) continue;
    const cmds = bot.commands || [];
    for (const c of cmds) {
      commands.push({
        command:     c.command || c.cmd,
        description: c.description || c.desc || '',
        usage:       c.usage || `/${c.command || c.cmd}`,
        botName:     bot.username || bot.displayName,
        botId:       bot._id,
      });
    }
  }

  res.json({ commands });
}));

module.exports = { router, botAuthMiddleware, verifyBotToken };

// ══════════════════════════════════════════════════
// BOT MARKETPLACE endpoints
// ══════════════════════════════════════════════════

// GET /api/bots/marketplace — public bot listing
router.get('/marketplace', asyncHandler(async (req, res) => {
  const { category, q, limit = 50 } = req.query;
  const query: Record<string,any> = { public: true };
  if (category && category !== 'all') query.category = category;

  let bots = await Bots.findPublic(query);

  // Filter by search query
  if (q) {
    const lq = q.toLowerCase();
    bots = bots.filter(b =>
      b.username?.toLowerCase().includes(lq) ||
      b.description?.toLowerCase().includes(lq)
    );
  }

  // Enrich with server count
  const enriched = await Promise.all(bots.slice(0, parseInt(limit)).map(async b => {
    const serverCount = await Bots.countServerInstalls(b._id);
    return {
      _id: b._id,
      username: b.username,
      description: b.description || '',
      category: b.category || 'utility',
      icon: b.icon || null,
      verified: b.verified || false,
      serverCount,
      rating: b.rating || 0,
      ratingCount: b.ratingCount || 0,
      commands: b.commands?.length || 0,
    };
  }));

  enriched.sort((a, b) => b.serverCount - a.serverCount);
  res.json(enriched);
}));

// GET /api/bots/marketplace/categories
router.get('/marketplace/categories', (req, res) => {
  res.json([
    { id: 'all',         label: 'Tümü',        icon: '🌐' },
    { id: 'moderation',  label: 'Moderasyon',  icon: '🛡️' },
    { id: 'music',       label: 'Müzik',       icon: '🎵' },
    { id: 'utility',     label: 'Araçlar',     icon: '🔧' },
    { id: 'fun',         label: 'Eğlence',     icon: '🎉' },
    { id: 'ai',          label: 'Yapay Zeka',  icon: '🤖' },
    { id: 'productivity',label: 'Verimlilik',  icon: '📊' },
    { id: 'games',       label: 'Oyunlar',     icon: '🎮' },
  ]);
});

// POST /api/bots/:botId/publish — make bot public on marketplace
router.post('/:botId/publish', authMiddleware, limits.bots(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const bot = await Bots.findById(req.params.botId);
  if (!bot) return res.status(404).json({ error: 'Bot not found' });
  const perms = await resolvePermissions(_u.id, bot.serverId);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission' });

  const { description, category, icon } = req.body;
  await Bots.update(bot._id, {
    public: true, description, category: category || 'utility', icon, updatedAt: Date.now(),
  });
  res.json({ ok: true });
}));

// POST /api/bots/:botId/rate — rate a marketplace bot
router.post('/:botId/rate', authMiddleware, limits.bots(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { rating } = req.body;
  if (!rating || rating < 1 || rating > 5)
    return res.status(400).json({ error: 'Rating must be 1-5' });
  const bot = await Bots.findById(req.params.botId);
  if (!bot || !bot.public) return res.status(404).json({ error: 'Bot not found' });

  // Upsert rating
  const existing = await Bots.findRating(bot._id, _u.id);
  if (existing) {
    await Bots.updateRating(existing._id, rating);
  } else {
    await Bots.insertRating(bot._id, _u.id, rating);
  }

  // Recalculate average
  const allRatings = await Bots.findAllRatings(bot._id);
  const avg = allRatings.reduce((s, r) => s + r.rating, 0) / allRatings.length;
  await Bots.update(bot._id, { rating: Math.round(avg * 10) / 10, ratingCount: allRatings.length });

  res.json({ ok: true, newRating: avg });
}));

// POST /api/servers/:sid/bots/:botId/add — add marketplace bot to server
router.post('/:sid/bots/:botId/add', authMiddleware, limits.bots(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const bot = await Bots.findById(req.params.botId);
  if (!bot || !bot.public) return res.status(404).json({ error: 'Bot not found on marketplace' });

  const already = await Bots.findServerBot(bot._id, req.params.sid);
  if (already) return res.status(409).json({ error: 'Bot already in server' });

  await Bots.addToServer(bot._id, req.params.sid, _u.id);

  res.json({ ok: true, bot: { _id: bot._id, username: bot.username } });
}));
export {};
