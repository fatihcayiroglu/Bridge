/**
 * @openapi
 * tags:
 *   - name: Onboarding
 *     description: Onboarding API endpoints

 *
 * /servers/{sid}/onboarding:
 *   get:
 *     tags: [Servers]
 *     summary: Onboarding sorularini getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Onboarding sorulari
 *   put:
 *     tags: [Servers]
 *     summary: Onboarding sorularini kaydet
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               questions: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: Kaydedildi
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /servers/{sid}/onboarding/status:
 *   get:
 *     tags: [Servers]
 *     summary: Kullanicinin onboarding durumunu getir
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Onboarding tamamlandi mi
 *
 * /servers/{sid}/onboarding/complete:
 *   post:
 *     tags: [Servers]
 *     summary: Onboarding tamamlandi olarak isaretle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               answers: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: Tamamlandi

 *
 * /servers/{sid}/onboarding:
 *   put:
 *     tags: [Servers]
 *     summary: Onboarding sorularini kaydet / guncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: sid
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               questions: { type: array, items: { type: object } }
 *     responses:
 *       200:
 *         description: Kaydedildi
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

// server/routes/onboarding.ts
// Sunucu Onboarding: yeni üyeler için karşılama wizard'ı.
//
// ENDPOINTS:
//   GET    /api/servers/:sid/onboarding           — onboarding ayarlarını getir
//   PUT    /api/servers/:sid/onboarding           — ayarları kaydet (admin)
//   POST   /api/servers/:sid/onboarding/complete  — üye wizard'ı tamamladı
//   GET    /api/servers/:sid/onboarding/status    — mevcut kullanıcı tamamladı mı?


import logger from '../lib/logger';
import express from 'express';
import { v4 as uuidv4 } from 'uuid';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router     = express.Router({ mergeParams: true });
import { Members, Channels, Users, Servers, Messages, ServerAssets, } from '../db/repositories';
import { authMiddleware} from '../middleware/auth';
import { resolvePermissions, hasPermission, PERMS } from '../lib/permissions';
import { limits } from '../middleware/rateLimit';
import { getIo } from '../socket';

type OnboardingConfig = {
  enabled?: boolean | number;
  rulesChannelId?: string | null;
  welcomeChannelId?: string | null;
  welcomeMessage?: string | null;
  verificationLevel?: number | string | null;
  defaultRoles?: string | string[] | null;
  questions?: string | unknown[] | null;
};

type NamedChannel = { _id: string; name: string };

function parseJsonArray(value: string | unknown[] | null | undefined): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// GET /api/servers/:sid/onboarding
router.get('/:sid/onboarding', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const member = await Members.findOne(_u.id, String(req.params.sid ?? ''));
  if (!member) return res.status(403).json({ error: 'Not a member' });

  let config = await ServerAssets.findOnboarding(String(req.params.sid ?? '')) as OnboardingConfig | null;
  if (!config) config = { enabled: false };

  // Kanal ve rol isimlerini çöz
  let channels: NamedChannel[] = [];
  try { channels = await Channels.findWhere({ serverId: String(req.params.sid ?? ''), type: 'text' }) as NamedChannel[]; } catch {}

  res.json({
    enabled: !!config.enabled,
    rulesChannelId: config.rulesChannelId,
    welcomeChannelId: config.welcomeChannelId,
    welcomeMessage: config.welcomeMessage || 'Sunucuya hoş geldin, {user}! 👋',
    verificationLevel: config.verificationLevel || 0,
    defaultRoles: parseJsonArray(config.defaultRoles),
    questions: parseJsonArray(config.questions),
    channels: channels.map(c => ({ _id: c._id, name: c.name })),
  });
});

// PUT /api/servers/:sid/onboarding — admin only
router.put('/:sid/onboarding', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const perms = await resolvePermissions(_u.id, String(req.params.sid ?? ''));
  if (!hasPermission(perms, PERMS.MANAGE_SERVER))
    return res.status(403).json({ error: 'Missing permission: MANAGE_SERVER' });

  const {
    enabled, rulesChannelId, welcomeChannelId,
    welcomeMessage, verificationLevel, defaultRoles, questions,
  } = req.body as { enabled?: boolean | string; rulesChannelId?: string; welcomeChannelId?: string; welcomeMessage?: string; verificationLevel?: string | number; defaultRoles?: string[]; questions?: unknown[] };

  const now = Date.now();
  await ServerAssets.upsertOnboarding(String(req.params.sid ?? ''), {
    enabled: enabled ? 1 : 0,
    rulesChannelId: rulesChannelId || null,
    welcomeChannelId: welcomeChannelId || null,
    welcomeMessage: (welcomeMessage || 'Sunucuya hoş geldin, {user}! 👋').slice(0, 500),
    verificationLevel: parseInt(String(verificationLevel ?? 0), 10) || 0,
    defaultRoles: JSON.stringify(defaultRoles || []),
    questions: JSON.stringify((Array.isArray(questions) ? questions : []).slice(0, 5)),
    updatedAt: now,
  });

  res.json({ ok: true });
});

// GET /api/servers/:sid/onboarding/status
router.get('/:sid/onboarding/status', authMiddleware, async (req, res) => {
  const _u = castAuthed(req).user;
  const member = await Members.findOne(_u.id, String(req.params.sid ?? ''));
  if (!member) return res.status(403).json({ error: 'Not a member' });

  const config = await ServerAssets.findOnboarding(String(req.params.sid ?? '')) as OnboardingConfig | null;
  if (!config || !config.enabled) return res.json({ required: false });

  const completion = await ServerAssets.findOnboardingCompletion(String(req.params.sid ?? ''), _u.id);

  res.json({
    required: true,
    completed: !!completion,
    completedAt: completion?.completedAt || null,
    config: {
      rulesChannelId: config.rulesChannelId,
      welcomeMessage: config.welcomeMessage,
      questions: parseJsonArray(config.questions),
      verificationLevel: config.verificationLevel || 0,
    },
  });
});

// POST /api/servers/:sid/onboarding/complete
router.post('/:sid/onboarding/complete', authMiddleware, limits.write(), async (req, res) => {
  const _u = castAuthed(req).user;
  const member = await Members.findOne(_u.id, String(req.params.sid ?? ''));
  if (!member) return res.status(403).json({ error: 'Not a member' });

  const config = await ServerAssets.findOnboarding(String(req.params.sid ?? '')) as OnboardingConfig | null;
  if (!config || !config.enabled) return res.json({ ok: true, skipped: true });

  const { answers = {} } = req.body;

  const existingCompletion = await ServerAssets.findOnboardingCompletion(String(req.params.sid ?? ''), _u.id);

  if (!existingCompletion) {
    await ServerAssets.insertOnboardingCompletion({
      _id: uuidv4(),
      serverId: String(req.params.sid ?? ''),
      userId: _u.id,
      completedAt: Date.now(),
      answers: JSON.stringify(answers),
    });
  }

  // Assign default roles if configured
  const defaultRoles = parseJsonArray(config.defaultRoles).filter((roleId): roleId is string => typeof roleId === 'string');
  for (const roleId of defaultRoles) {
    try {
      const already = await ServerAssets.findMemberRole(_u.id, roleId, String(req.params.sid ?? ''));
      if (!already) {
        await ServerAssets.insertMemberRole({ _id: uuidv4(), userId: _u.id, roleId, serverId: String(req.params.sid ?? '') });
      }
    } catch (err) { logger.warn({ err, event: 'onboarding.fetch.error' }, 'Onboarding fetch failed silently'); }
  }

  // Send welcome message to welcome channel
  if (config.welcomeChannelId) {
    try {
      const user = await Users.findById(_u.id);
      const displayName = member.nickname || user?.displayName || user?.username || 'yeni üye';
      const text = (config.welcomeMessage || 'Sunucuya hoş geldin, {user}! 👋')
        .replace('{user}', `@${displayName}`)
        .replace('{server}', (await Servers.findById(String(req.params.sid ?? '')))?.name || 'sunucu');

        const msgId = uuidv4();
      await Messages.create({
        _id: msgId,
        channelId: config.welcomeChannelId,
        serverId: String(req.params.sid ?? ''),
        userId: 'system',
        username: 'Bridge',
        displayName: 'Bridge',
        content: text,
        type: 'welcome',
        createdAt: Date.now(),
      });

      // Broadcast via socket if io is available
      try {
        const io = getIo();
        if (io) {
          io.to(`channel:${config.welcomeChannelId}`).emit('message:new', {
            _id: msgId, channelId: config.welcomeChannelId, serverId: String(req.params.sid ?? ''),
            userId: 'system', username: 'Bridge', displayName: 'Bridge',
            content: text, type: 'welcome', createdAt: Date.now(),
          });
        }
      } catch (err) { logger.warn({ err, event: 'onboarding.fetch.error' }, 'Onboarding fetch failed silently'); }
    } catch (err) { logger.warn({ err, event: 'onboarding.fetch.error' }, 'Onboarding fetch failed silently'); }
  }

  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
