// @ts-nocheck
// server/routes/interactions.js
// Bot button/select/modal/context-menu interaction routing
const express = require('express');
const router  = express.Router();
const { Messages, Bots } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

// POST /api/interactions — forward to bot webhook/socket
router.post('/', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { type, messageId, customId, value, channelId, serverId,
          targetUserId, targetMessageId, modalData } = req.body;

  const VALID_TYPES = ['button', 'select', 'modal_submit', 'user_command', 'message_command'];
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid interaction type' });

  // For message/button interactions, messageId required
  if (['button', 'select', 'modal_submit'].includes(type) && !messageId && !customId)
    return res.status(400).json({ error: 'messageId and customId required' });

  let bot = null;
  let msg = null;

  if (messageId) {
    msg = await Messages.findById(messageId);
    if (!msg) return res.status(404).json({ error: 'Message not found' });
    bot = msg.botId ? await Bots.findById(msg.botId) : null;
  }

  // For context menu commands, look up bot by command name
  if (['user_command', 'message_command'].includes(type) && customId) {
    const allBots = await Bots.findWhere({});
    for (const b of allBots) {
      const cmds = JSON.parse(b.contextCommands || '[]');
      if (cmds.find(c => c.name === customId)) { bot = b; break; }
    }
  }

  const payload = {
    type,
    customId:        customId || null,
    value:           value || null,
    messageId:       messageId || null,
    channelId:       channelId || null,
    serverId:        serverId || null,
    userId:          _u.id,
    displayName:     _u.displayName,
    botId:           bot?._id || msg?.botId || null,
    targetUserId:    targetUserId || null,
    targetMessageId: targetMessageId || null,
    modalData:       modalData || null,
  };

  // Emit via socket so bot SDK can handle it
  const io = req.app.get('io');
  if (io) {
    io.emit('interaction', payload);
  }

  // If bot has a webhook URL, POST to it
  if (bot?.webhookUrl) {
    const fetch = globalThis.fetch;
    fetch(bot.webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'INTERACTION', data: payload }),
    }).catch(err => console.warn('[Interaction webhook]', err.message));
  }

  res.json({ ok: true });
}));

// GET /api/interactions/context-commands — sunucuya kayıtlı context menu komutları
router.get('/context-commands', authMiddleware, asyncHandler(async (req, res) => {
  const { serverId } = req.query;
  if (!serverId) return res.status(400).json({ error: 'serverId required' });

  const serverBots = await Bots.findServerBots(serverId);
  const botIds     = serverBots.map(sb => sb.botId);
  const bots       = botIds.length ? await Bots.findWhere({ _id: { $in: botIds } }) : [];

  const commands = [];
  for (const b of bots) {
    const cmds = JSON.parse(b.contextCommands || '[]');
    cmds.forEach(c => commands.push({ ...c, botId: b._id, botName: b.username }));
  }
  res.json(commands);
}));

module.exports = router;
export {};
