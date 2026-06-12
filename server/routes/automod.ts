/**
 * @openapi
 * tags:
 *   - name: Automod
 *     description: Automod API endpoints

 *
 * /automod/{serverId}:
 *   get:
 *     tags: [Moderation]
 *     summary: Sunucu automod kurallarini getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Automod kurallari
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   put:
 *     tags: [Moderation]
 *     summary: Automod kurallarini guncelle
 *     security: [{ bearerAuth: [] }]
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
 *             properties:
 *               rules: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: Guncellendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /automod/{serverId}/test:
 *   post:
 *     tags: [Moderation]
 *     summary: Metni automod kurallariyla test et
 *     security: [{ bearerAuth: [] }]
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
 *             required: [content]
 *             properties:
 *               content: { type: string }
 *     responses:
 *       200:
 *         description: Test sonucu
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /automod/{serverId}/logs:
 *   get:
 *     tags: [Moderation]
 *     summary: Automod log kayitlari
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Log listesi
 *       403: { $ref: '#/components/responses/Forbidden' }

 *
 * /automod/{serverId}:
 *   post:
 *     tags: [Moderation]
 *     summary: Automod kurali olustur
 *     security: [{ bearerAuth: [] }]
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
 *             required: [type, action]
 *             properties:
 *               type:    { type: string }
 *               trigger: { type: object }
 *               action:  { type: object }
 *     responses:
 *       201:
 *         description: Kural olusturuldu
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /automod/{serverId}/{rid}:
 *   patch:
 *     tags: [Moderation]
 *     summary: Automod kuralini guncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: rid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200:
 *         description: Guncellendi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Moderation]
 *     summary: Automod kuralini sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: rid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Silindi
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

// server/routes/automod.ts

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router     = express.Router({ mergeParams: true });
import { Automod, Members } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { limits } from '../middleware/rateLimit';

const VALID_TYPES = ['blocked_words','spam_messages','caps_lock','link_filter','invite_filter','mention_spam','repeated_chars'];
const MAX_RULES   = 20;

function parseJsonConfig(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch { return {}; }
}

async function checkMod(userId: string, serverId: string): Promise<boolean> {
  const perms = await resolvePermissions(userId, serverId);
  return hasPermission(perms, PERMS.MANAGE_SERVER);
}

// GET /api/servers/:sid/automod
router.get('/', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const member = await Members.findOne(_u.id, String(req.params.sid ?? ''));
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const rules = await Automod.findByServer(String(req.params.sid ?? ''));
  res.json(rules.map(r => ({ ...r, config: parseJsonConfig(r.config) })));
});

// POST /api/servers/:sid/automod
router.post('/', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await checkMod(_u.id, String(req.params.sid ?? '')))
    return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });

  const { type, config: rawConfig = {}, enabled = true } = req.body as { type?: unknown; config?: Record<string, unknown>; enabled?: boolean };
  const config: Record<string, unknown> = rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig) ? rawConfig : {};
  if (typeof type !== 'string' || !VALID_TYPES.includes(type))
    return res.status(400).json({ error: `Geçersiz tür. Desteklenenler: ${VALID_TYPES.join(', ')}` });

  const count = await Automod.count(String(req.params.sid ?? ''));
  if (count >= MAX_RULES) return res.status(429).json({ error: `Maksimum ${MAX_RULES} kural` });

  if (type === 'blocked_words') {
    if (!Array.isArray(config.words) || !config.words.length) return res.status(400).json({ error: 'blocked_words için config.words dizisi gerekli' });
    config.words = config.words.slice(0, 100).map((w: unknown) => String(w).toLowerCase().slice(0, 50));
  }
  if (type === 'spam_messages') { config.maxMessages = Math.min(parseInt(String(config.maxMessages)) || 5, 20); config.windowSecs = Math.min(parseInt(String(config.windowSecs)) || 5, 60); }
  if (type === 'caps_lock')      config.minLength   = Math.min(parseInt(String(config.minLength))   || 8, 50);
  if (type === 'mention_spam')   config.maxMentions = Math.min(parseInt(String(config.maxMentions)) || 5, 20);
  if (type === 'repeated_chars') config.minRepeat   = Math.min(parseInt(String(config.minRepeat))   || 10, 30);
  config.action      = ['delete','timeout','delete_and_timeout'].includes(String(config.action)) ? config.action : 'delete';
  config.timeoutMs   = Math.min(parseInt(String(config.timeoutMs)) || 60000, 7 * 24 * 60 * 60 * 1000);
  config.logChannelId = config.logChannelId || null;
  config.exemptRoles  = Array.isArray(config.exemptRoles) ? config.exemptRoles.slice(0, 10) : [];

  const rule = await Automod.insert({ serverId: String(req.params.sid ?? ''), type, enabled: enabled ? 1 : 0, config: JSON.stringify(config), createdBy: _u.id, updatedAt: Date.now() });
  res.status(201).json({ ...rule, config });
});

// PATCH /api/servers/:sid/automod/:rid
router.patch('/:rid', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await checkMod(_u.id, String(req.params.sid ?? ''))) return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });
  const rule = await Automod.findByIdAndServer(String(req.params.rid ?? ''), String(req.params.sid ?? ''));
  if (!rule) return res.status(404).json({ error: 'Kural bulunamadı' });
  const patch: Record<string, unknown> = { updatedAt: Date.now() };
  if (req.body.enabled != null) patch.enabled = req.body.enabled ? 1 : 0;
  if (req.body.config  != null) patch.config  = JSON.stringify(req.body.config);
  await Automod.update(String(req.params.rid ?? ''), patch);
  const updated = await Automod.findById(String(req.params.rid ?? ''));
  if (!updated) return res.status(404).json({ error: 'Kural bulunamadı' });
  res.json({ ...updated, config: parseJsonConfig(updated.config) });
});

// DELETE /api/servers/:sid/automod/:rid
router.delete('/:rid', authMiddleware, limits.moderation(), async (req, res) => {
  const _u = castAuthed(req).user;
  if (!await checkMod(_u.id, String(req.params.sid ?? ''))) return res.status(403).json({ error: 'Yönetici yetkisi gerekli' });
  const rule = await Automod.findByIdAndServer(String(req.params.rid ?? ''), String(req.params.sid ?? ''));
  if (!rule) return res.status(404).json({ error: 'Kural bulunamadı' });
  await Automod.delete(String(req.params.rid ?? ''));
  res.json({ deleted: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
