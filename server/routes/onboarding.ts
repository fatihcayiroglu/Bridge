// server/routes/onboarding.js
// Sunucu Onboarding: yeni üyeler için karşılama wizard'ı.
//
// ENDPOINTS:
//   GET    /api/servers/:sid/onboarding           — onboarding ayarlarını getir
//   PUT    /api/servers/:sid/onboarding           — ayarları kaydet (admin)
//   POST   /api/servers/:sid/onboarding/complete  — üye wizard'ı tamamladı
//   GET    /api/servers/:sid/onboarding/status    — mevcut kullanıcı tamamladı mı?

'use strict';

const express    = require('express');
const { v4: uuidv4 } = require('uuid');
const router     = express.Router({ mergeParams: true });
const {
  Members, Channels, Users, Servers, Messages, ServerAssets,
} = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { resolvePermissions, hasPermission, PERMS } = require('../lib/permissions');
const asyncHandler = require('../middleware/asyncHandler');
const { limits } = require('../middleware/rateLimit'); // rate limiting

// GET /api/servers/:sid/onboarding
router.get('/:sid/onboarding', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const member = await Members.findOne(_u.id, req.params.sid);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  let config = await ServerAssets.findOnboarding(req.params.sid);
  if (!config) config = { enabled: false };

  // Kanal ve rol isimlerini çöz
  let channels: any[] = [];
  try { channels = await Channels.findWhere({ serverId: req.params.sid, type: 'text' }); } catch {}

  res.json({
    enabled: !!config.enabled,
    rulesChannelId: config.rulesChannelId,
    welcomeChannelId: config.welcomeChannelId,
    welcomeMessage: config.welcomeMessage || 'Sunucuya hoş geldin, {user}! 👋',
    verificationLevel: config.verificationLevel || 0,
    defaultRoles: JSON.parse(config.defaultRoles || '[]'),
    questions: JSON.parse(config.questions || '[]'),
    channels: channels.map(c => ({ _id: c._id, name: c.name })),
  });
}));

// PUT /api/servers/:sid/onboarding — admin only
router.put('/:sid/onboarding', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, req.params.sid);
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const {
    enabled, rulesChannelId, welcomeChannelId,
    welcomeMessage, verificationLevel, defaultRoles, questions,
  } = req.body;

  const now = Date.now();
  await ServerAssets.upsertOnboarding(req.params.sid, {
    enabled: enabled ? 1 : 0,
    rulesChannelId: rulesChannelId || null,
    welcomeChannelId: welcomeChannelId || null,
    welcomeMessage: (welcomeMessage || 'Sunucuya hoş geldin, {user}! 👋').slice(0, 500),
    verificationLevel: parseInt(verificationLevel) || 0,
    defaultRoles: JSON.stringify(defaultRoles || []),
    questions: JSON.stringify((questions || []).slice(0, 5)),
    updatedAt: now,
  });

  res.json({ ok: true });
}));

// GET /api/servers/:sid/onboarding/status
router.get('/:sid/onboarding/status', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const member = await Members.findOne(_u.id, req.params.sid);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  const config = await ServerAssets.findOnboarding(req.params.sid);
  if (!config || !config.enabled) return res.json({ required: false });

  const completion = await ServerAssets.findOnboardingCompletion(req.params.sid, _u.id);

  res.json({
    required: true,
    completed: !!completion,
    completedAt: completion?.completedAt || null,
    config: {
      rulesChannelId: config.rulesChannelId,
      welcomeMessage: config.welcomeMessage,
      questions: JSON.parse(config.questions || '[]'),
      verificationLevel: config.verificationLevel || 0,
    },
  });
}));

// POST /api/servers/:sid/onboarding/complete
router.post('/:sid/onboarding/complete', authMiddleware, limits.write(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const member = await Members.findOne(_u.id, req.params.sid);
  if (!member) return res.status(403).json({ error: 'Not a member' });

  const config = await ServerAssets.findOnboarding(req.params.sid);
  if (!config || !config.enabled) return res.json({ ok: true, skipped: true });

  const { answers = {} } = req.body;

  const existingCompletion = await ServerAssets.findOnboardingCompletion(req.params.sid, _u.id);

  if (!existingCompletion) {
    await ServerAssets.insertOnboardingCompletion({
      _id: uuidv4(),
      serverId: req.params.sid,
      userId: _u.id,
      completedAt: Date.now(),
      answers: JSON.stringify(answers),
    });
  }

  // Assign default roles if configured
  const defaultRoles = JSON.parse(config.defaultRoles || '[]');
  for (const roleId of defaultRoles) {
    try {
      const already = await ServerAssets.findMemberRole(_u.id, roleId, req.params.sid);
      if (!already) {
        await ServerAssets.insertMemberRole({ _id: uuidv4(), userId: _u.id, roleId, serverId: req.params.sid });
      }
    } catch {}
  }

  // Send welcome message to welcome channel
  if (config.welcomeChannelId) {
    try {
      const user = await Users.findById(_u.id);
      const displayName = member.nickname || user?.displayName || user?.username || 'yeni üye';
      const text = (config.welcomeMessage || 'Sunucuya hoş geldin, {user}! 👋')
        .replace('{user}', `@${displayName}`)
        .replace('{server}', (await Servers.findById(req.params.sid))?.name || 'sunucu');

        const msgId = uuidv4();
      await Messages.create({
        _id: msgId,
        channelId: config.welcomeChannelId,
        serverId: req.params.sid,
        userId: 'system',
        username: 'Bridge',
        displayName: 'Bridge',
        content: text,
        type: 'welcome',
        createdAt: Date.now(),
      });

      // Broadcast via socket if io is available
      try {
        const { getIo } = require('../socket');
        const io = getIo();
        if (io) {
          io.to(`channel:${config.welcomeChannelId}`).emit('message:new', {
            _id: msgId, channelId: config.welcomeChannelId, serverId: req.params.sid,
            userId: 'system', username: 'Bridge', displayName: 'Bridge',
            content: text, type: 'welcome', createdAt: Date.now(),
          });
        }
      } catch {}
    } catch {}
  }

  res.json({ ok: true });
}));

module.exports = router;
export {};
