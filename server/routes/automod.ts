/**
 * @openapi
 * tags:
 *   - name: Automod
 *     description: Persisted realtime AutoMod rule management
 *
 * /servers/{sid}/automod:
 *   get:
 *     tags: [Automod]
 *     summary: List server AutoMod rules
 *     security: [{ bearerAuth: [] }]
 *   post:
 *     tags: [Automod]
 *     summary: Create an AutoMod rule
 *     security: [{ bearerAuth: [] }]
 *
 * /servers/{sid}/automod/{rid}:
 *   patch:
 *     tags: [Automod]
 *     summary: Update an AutoMod rule
 *     security: [{ bearerAuth: [] }]
 *   delete:
 *     tags: [Automod]
 *     summary: Delete an AutoMod rule
 *     security: [{ bearerAuth: [] }]
 */

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
import { Automod, Members, Channels, Roles } from '../db/repositories';
import { authMiddleware } from '../middleware/auth';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { limits } from '../middleware/rateLimit';
import type { AutomodRule } from '../db/repositories/types/entities';
import {
  AUTOMOD_RULE_TYPES,
  isAutomodRuleType,
  normalizeAutomodConfig,
  parseStoredAutomodConfig,
  type AutomodConfig,
} from '../lib/automodPolicy';

const router = express.Router({ mergeParams: true });
const MAX_RULES = 20;
const CREATE_KEYS = new Set(['type', 'config', 'enabled']);
const PATCH_KEYS = new Set(['config', 'enabled']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function serializeRule(rule: AutomodRule): Record<string, unknown> {
  return { ...rule, config: parseStoredAutomodConfig(rule.config) };
}

function hasOnlyKeys(body: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(body).every((key) => allowed.has(key));
}

async function checkMod(userId: string, serverId: string): Promise<boolean> {
  // Permission resolution is not a membership oracle.  A stale role/cache or
  // permissive test adapter must never turn a non-member into a moderator.
  if (!await Members.findOne(userId, serverId)) return false;
  const perms = await resolvePermissions(userId, serverId);
  return hasPermission(perms, PERMS.MANAGE_SERVER);
}

/** Canonical tenant validation for ids persisted inside config JSONB. */
async function validateConfigReferences(
  serverId: string,
  config: AutomodConfig,
): Promise<string | null> {
  if (config.logChannelId) {
    const channel = await Channels.findByIdAndServer(config.logChannelId, serverId);
    if (!channel || !['text', 'announcement'].includes(String(channel.type || 'text'))) {
      return 'config.logChannelId bu sunucuya ait mesaj kanalı olmalı';
    }
  }
  for (const roleId of config.exemptRoles) {
    const role = await Roles.findByIdAndServer(roleId, serverId);
    if (!role) return 'config.exemptRoles yalnızca bu sunucuya ait rolleri içerebilir';
  }
  return null;
}

// GET /api/servers/:sid/automod
router.get('/', authMiddleware, async (req, res) => {
  const user = castAuthed(req).user;
  const serverId = String(req.params.sid ?? '');
  // Rule bodies expose blocked words, exemptions and moderation log targets;
  // listing them is a management surface, not ordinary member-visible data.
  if (!await checkMod(user.id, serverId)) return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });
  const rules = await Automod.findByServer(serverId);
  return res.json(rules.map((rule) => serializeRule(rule)));
});

// POST /api/servers/:sid/automod
router.post('/', authMiddleware, limits.moderation(), async (req, res) => {
  const user = castAuthed(req).user;
  const serverId = String(req.params.sid ?? '');
  if (!await checkMod(user.id, serverId)) return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });

  if (!isPlainObject(req.body) || !hasOnlyKeys(req.body, CREATE_KEYS)) {
    return res.status(400).json({ error: 'Geçersiz AutoMod isteği' });
  }
  if (!isAutomodRuleType(req.body.type)) {
    return res.status(400).json({ error: `Geçersiz tür. Desteklenenler: ${AUTOMOD_RULE_TYPES.join(', ')}` });
  }
  if (req.body.enabled !== undefined && typeof req.body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled boolean olmalı' });
  }

  const normalized = normalizeAutomodConfig(req.body.type, req.body.config ?? {});
  if (!normalized.ok) return res.status(400).json({ error: normalized.error });
  const referenceError = await validateConfigReferences(serverId, normalized.config);
  if (referenceError) return res.status(400).json({ error: referenceError });

  const count = await Automod.count(serverId);
  if (count >= MAX_RULES) return res.status(429).json({ error: `Maksimum ${MAX_RULES} kural` });

  const rule = await Automod.insert({
    serverId,
    type: req.body.type,
    enabled: req.body.enabled ?? true,
    config: normalized.config,
    createdBy: user.id,
    updatedAt: Date.now(),
  });
  return res.status(201).json(serializeRule(rule));
});

// PATCH /api/servers/:sid/automod/:rid
router.patch('/:rid', authMiddleware, limits.moderation(), async (req, res) => {
  const user = castAuthed(req).user;
  const serverId = String(req.params.sid ?? '');
  const ruleId = String(req.params.rid ?? '');
  if (!await checkMod(user.id, serverId)) return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });

  const rule = await Automod.findByIdAndServer(ruleId, serverId);
  if (!rule) return res.status(404).json({ error: 'Kural bulunamadı' });
  if (!isPlainObject(req.body) || !hasOnlyKeys(req.body, PATCH_KEYS) || Object.keys(req.body).length === 0) {
    return res.status(400).json({ error: 'Geçersiz AutoMod güncellemesi' });
  }
  if (req.body.enabled !== undefined && typeof req.body.enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled boolean olmalı' });
  }

  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (req.body.enabled !== undefined) patch.enabled = req.body.enabled;

  if (req.body.config !== undefined) {
    if (!isPlainObject(req.body.config) || !isAutomodRuleType(rule.type)) {
      return res.status(400).json({ error: 'config veya kayıtlı kural türü geçersiz' });
    }
    const merged = { ...parseStoredAutomodConfig(rule.config), ...req.body.config };
    const normalized = normalizeAutomodConfig(rule.type, merged);
    if (!normalized.ok) return res.status(400).json({ error: normalized.error });
    const referenceError = await validateConfigReferences(serverId, normalized.config);
    if (referenceError) return res.status(400).json({ error: referenceError });
    patch.config = normalized.config;
  }

  await Automod.update(ruleId, serverId, patch);
  const updated = await Automod.findByIdAndServer(ruleId, serverId);
  if (!updated) return res.status(404).json({ error: 'Kural bulunamadı' });
  return res.json(serializeRule(updated));
});

// DELETE /api/servers/:sid/automod/:rid
router.delete('/:rid', authMiddleware, limits.moderation(), async (req, res) => {
  const user = castAuthed(req).user;
  const serverId = String(req.params.sid ?? '');
  const ruleId = String(req.params.rid ?? '');
  if (!await checkMod(user.id, serverId)) return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });
  const rule = await Automod.findByIdAndServer(ruleId, serverId);
  if (!rule) return res.status(404).json({ error: 'Kural bulunamadı' });
  await Automod.delete(ruleId, serverId);
  return res.json({ deleted: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
