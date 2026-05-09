// server/routes/webhooks.js
// Kanal webhook'larını yönetir (oluştur, listele, sil)
// Gelen webhook POST'ları bots.js'de işlenir.
//
// ENDPOINTS:
//   GET    /api/channels/:cid/webhooks         — kanalın webhook'larını listele
//   POST   /api/channels/:cid/webhooks         — yeni webhook oluştur
//   DELETE /api/channels/:cid/webhooks/:wid    — webhook sil
//   GET    /api/webhooks/:wid                  — webhook bilgisi (token ile)

const express      = require('express');
const crypto       = require('crypto');
const { v4: uuidv4 } = require('uuid');
const router       = express.Router({ mergeParams: true });
const { Channels, ChannelWebhooks } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { resolvePermissions, hasPermission, PERMS } = require('../lib/permissions');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

// GET /api/channels/:cid/webhooks
router.get('/:cid/webhooks', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await Channels.findById(req.params.cid);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const perms = await resolvePermissions(_u.id, channel.serverId);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const webhooks = await ChannelWebhooks.findByChannel(req.params.cid);
  // secret'ı gizle, sadece token (masked) göster
  res.json(webhooks.map(w => ({
    _id:       w._id,
    name:      w.name,
    channelId: w.channelId,
    serverId:  w.serverId,
    url:       `/api/webhooks/${w._id}?token=${w.token}`,
    createdAt: w.createdAt,
  })));
}));

// POST /api/channels/:cid/webhooks
router.post('/:cid/webhooks', authMiddleware, limits.webhooks(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await Channels.findById(req.params.cid);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const perms = await resolvePermissions(_u.id, channel.serverId);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Webhook name required' });

  // Kanal başına max 10 webhook
  const existing = await ChannelWebhooks.findByChannel(req.params.cid);
  if (existing.length >= 10)
    return res.status(429).json({ error: 'Max 10 webhooks per channel' });

  const webhookId = uuidv4();
  const secret    = crypto.randomBytes(32).toString('hex');
  // token = HMAC(secret, webhookId) — kullanıcıya URL'de gösterilir
  const token     = crypto.createHmac('sha256', secret).update(webhookId).digest('hex');

  const webhook = await ChannelWebhooks.insert({
    _id:       webhookId,
    serverId:  channel.serverId,
    channelId: req.params.cid,
    name:      name.trim().slice(0, 80),
    secret,
    token,
    createdBy: _u.id,
    createdAt: Date.now(),
  });

  res.status(201).json({
    _id:       webhook._id,
    name:      webhook.name,
    channelId: webhook.channelId,
    serverId:  webhook.serverId,
    url:       `/api/webhooks/${webhook._id}?token=${token}`,
    createdAt: webhook.createdAt,
    warning:   'Bu URL\'i güvenli saklayın — webhook mesajı göndermek için gerekli.',
  });
}));

// DELETE /api/channels/:cid/webhooks/:wid
router.delete('/:cid/webhooks/:wid', authMiddleware, limits.webhooks(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const channel = await Channels.findById(req.params.cid);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });

  const perms = await resolvePermissions(_u.id, channel.serverId);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const webhook = await ChannelWebhooks.findOne({ _id: req.params.wid, channelId: req.params.cid });
  if (!webhook) return res.status(404).json({ error: 'Webhook not found' });

  await ChannelWebhooks.remove({ _id: req.params.wid });
  res.json({ deleted: true });
}));

module.exports = router;
export {};
