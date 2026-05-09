// server/routes/automod.js
'use strict';

const express    = require('express');
const router     = express.Router({ mergeParams: true });
const { Automod, Members } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { resolvePermissions, hasPermission, PERMS } = require('../lib/permissions');
const { limits } = require('../middleware/rateLimit');

const VALID_TYPES = ['blocked_words','spam_messages','caps_lock','link_filter','invite_filter','mention_spam','repeated_chars'];
const MAX_RULES   = 20;

async function checkMod(userId, serverId) {
  const perms = await resolvePermissions(userId, serverId);
  return hasPermission(perms, PERMS.MANAGE_SERVER);
}

// GET /api/servers/:sid/automod
router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const member = await Members.findOne(_u.id, req.params.sid);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const rules = await Automod.findByServer(req.params.sid);
  res.json(rules.map(r => ({ ...r, config: (() => { try { return JSON.parse(r.config); } catch { return {}; } })() })));
}));

// POST /api/servers/:sid/automod
router.post('/', authMiddleware, limits.moderation(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await checkMod(_u.id, req.params.sid))
    return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });

  const { type, config = {}, enabled = true } = req.body;
  if (!VALID_TYPES.includes(type))
    return res.status(400).json({ error: `Geçersiz tür. Desteklenenler: ${VALID_TYPES.join(', ')}` });

  const count = await Automod.count(req.params.sid);
  if (count >= MAX_RULES) return res.status(429).json({ error: `Maksimum ${MAX_RULES} kural` });

  if (type === 'blocked_words') {
    if (!Array.isArray(config.words) || !config.words.length) return res.status(400).json({ error: 'blocked_words için config.words dizisi gerekli' });
    config.words = config.words.slice(0, 100).map(w => String(w).toLowerCase().slice(0, 50));
  }
  if (type === 'spam_messages') { config.maxMessages = Math.min(parseInt(config.maxMessages) || 5, 20); config.windowSecs = Math.min(parseInt(config.windowSecs) || 5, 60); }
  if (type === 'caps_lock')      config.minLength   = Math.min(parseInt(config.minLength)   || 8, 50);
  if (type === 'mention_spam')   config.maxMentions = Math.min(parseInt(config.maxMentions) || 5, 20);
  if (type === 'repeated_chars') config.minRepeat   = Math.min(parseInt(config.minRepeat)   || 10, 30);
  config.action      = ['delete','timeout','delete_and_timeout'].includes(config.action) ? config.action : 'delete';
  config.timeoutMs   = Math.min(parseInt(config.timeoutMs) || 60000, 7 * 24 * 60 * 60 * 1000);
  config.logChannelId = config.logChannelId || null;
  config.exemptRoles  = Array.isArray(config.exemptRoles) ? config.exemptRoles.slice(0, 10) : [];

  const rule = await Automod.insert({ serverId: req.params.sid, type, enabled: enabled ? 1 : 0, config: JSON.stringify(config), createdBy: _u.id, updatedAt: Date.now() });
  res.status(201).json({ ...rule, config });
}));

// PATCH /api/servers/:sid/automod/:rid
router.patch('/:rid', authMiddleware, limits.moderation(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await checkMod(_u.id, req.params.sid)) return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });
  const rule = await Automod.findByIdAndServer(req.params.rid, req.params.sid);
  if (!rule) return res.status(404).json({ error: 'Kural bulunamadı' });
  const patch: Record<string,any> = { updatedAt: Date.now() };
  if (req.body.enabled != null) patch.enabled = req.body.enabled ? 1 : 0;
  if (req.body.config  != null) patch.config  = JSON.stringify(req.body.config);
  await Automod.update(req.params.rid, patch);
  const updated = await Automod.findById(req.params.rid);
  res.json({ ...updated, config: (() => { try { return JSON.parse(updated.config); } catch { return {}; } })() });
}));

// DELETE /api/servers/:sid/automod/:rid
router.delete('/:rid', authMiddleware, limits.moderation(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await checkMod(_u.id, req.params.sid)) return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });
  const rule = await Automod.findByIdAndServer(req.params.rid, req.params.sid);
  if (!rule) return res.status(404).json({ error: 'Kural bulunamadı' });
  await Automod.delete(req.params.rid);
  res.json({ deleted: true });
}));

module.exports = router;
export {};
