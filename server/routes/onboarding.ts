/**
 * @openapi
 * tags:
 *   - name: Onboarding
 *     description: Onboarding API endpoints
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
import { publishPersistedMessage } from '../lib/channelActivity';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router     = express.Router({ mergeParams: true });
import { Members, Channels, Users, Servers, Messages, ServerAssets, Roles } from '../db/repositories';
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

  const sid = String(req.params.sid ?? '');
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? req.body as Record<string, unknown>
    : {};
  const enabled = body.enabled;
  const rulesChannelId = body.rulesChannelId;
  const welcomeChannelId = body.welcomeChannelId;
  const welcomeMessage = body.welcomeMessage;
  const verificationLevel = body.verificationLevel;
  const defaultRoles = body.defaultRoles;
  const questions = body.questions;

  if (enabled !== undefined && typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
  if (rulesChannelId !== undefined && rulesChannelId !== null && typeof rulesChannelId !== 'string') return res.status(400).json({ error: 'rulesChannelId invalid' });
  if (welcomeChannelId !== undefined && welcomeChannelId !== null && typeof welcomeChannelId !== 'string') return res.status(400).json({ error: 'welcomeChannelId invalid' });
  if (welcomeMessage !== undefined && (typeof welcomeMessage !== 'string' || welcomeMessage.length > 500)) return res.status(400).json({ error: 'welcomeMessage invalid' });
  if (verificationLevel !== undefined && (!Number.isInteger(verificationLevel) || (verificationLevel as number) < 0 || (verificationLevel as number) > 2147483647)) {
    return res.status(400).json({ error: 'verificationLevel invalid' });
  }
  if (defaultRoles !== undefined && (!Array.isArray(defaultRoles) || defaultRoles.length > 25 || defaultRoles.some(roleId => typeof roleId !== 'string' || !roleId))) {
    return res.status(400).json({ error: 'defaultRoles invalid' });
  }
  if (questions !== undefined && (!Array.isArray(questions) || questions.length > 5 || JSON.stringify(questions).length > 32768)) {
    return res.status(400).json({ error: 'questions invalid' });
  }

  for (const channelId of [rulesChannelId, welcomeChannelId]) {
    if (typeof channelId !== 'string' || !channelId) continue;
    const channel = await Channels.findByIdAndServer(channelId, sid) as { type?: string } | null;
    if (!channel || channel.type !== 'text') return res.status(400).json({ error: 'Onboarding channel must be a text channel in this server' });
  }

  const roleIds = Array.isArray(defaultRoles) ? [...new Set(defaultRoles as string[])] : [];
  for (const roleId of roleIds) {
    if (!await Roles.findByIdAndServer(roleId, sid)) return res.status(400).json({ error: 'defaultRoles contains a role outside this server' });
  }

  const now = Date.now();
  await ServerAssets.upsertOnboarding(sid, {
    enabled: enabled === true,
    rulesChannelId: typeof rulesChannelId === 'string' && rulesChannelId ? rulesChannelId : null,
    welcomeChannelId: typeof welcomeChannelId === 'string' && welcomeChannelId ? welcomeChannelId : null,
    welcomeMessage: typeof welcomeMessage === 'string' && welcomeMessage ? welcomeMessage : 'Sunucuya hoş geldin, {user}! 👋',
    verificationLevel: typeof verificationLevel === 'number' ? verificationLevel : 0,
    defaultRoles: JSON.stringify(roleIds),
    questions: JSON.stringify(Array.isArray(questions) ? questions : []),
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

  const sid = String(req.params.sid ?? '');
  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body))
    ? req.body as Record<string, unknown>
    : {};
  const answers = body.answers ?? {};
  const answersJson = JSON.stringify(answers);
  if (answersJson.length > 65536) return res.status(400).json({ error: 'answers too large' });

  const claimed = await ServerAssets.claimOnboardingCompletion({
    _id: uuidv4(), serverId: sid, userId: _u.id, completedAt: Date.now(), answers: answersJson,
  });
  if (!claimed) return res.json({ ok: true, alreadyCompleted: true });

  // Assign only roles that still canonically belong to this server. Roles are
  // stored on members.roles JSONB; there is no separate member_roles owner.
  const configuredRoles = parseJsonArray(config.defaultRoles).filter((roleId): roleId is string => typeof roleId === 'string');
  const currentRoles = parseJsonArray((member as { roles?: string | string[] }).roles as string | string[] | undefined)
    .filter((roleId): roleId is string => typeof roleId === 'string');
  const nextRoles = new Set(currentRoles);
  for (const roleId of configuredRoles) {
    try {
      if (await Roles.findByIdAndServer(roleId, sid)) nextRoles.add(roleId);
      else logger.warn({ roleId, serverId: sid, event: 'onboarding.role.stale' }, 'Skipping stale/cross-server onboarding role');
    } catch (err) { logger.warn({ err, roleId, event: 'onboarding.role.resolve_error' }, 'Onboarding role resolution failed'); }
  }
  if (nextRoles.size !== currentRoles.length) {
    try { await Members.setRoles(_u.id, sid, [...nextRoles]); }
    catch (err) { logger.warn({ err, event: 'onboarding.role.assign_error' }, 'Onboarding role assignment failed'); }
  }

  // Send welcome message to welcome channel
  if (config.welcomeChannelId) {
    try {
      const welcomeChannel = await Channels.findByIdAndServer(String(config.welcomeChannelId), sid) as { type?: string } | null;
      if (!welcomeChannel || welcomeChannel.type !== 'text') {
        logger.warn({ channelId: config.welcomeChannelId, serverId: sid, event: 'onboarding.welcome.stale' }, 'Skipping stale/cross-server onboarding welcome channel');
        return res.json({ ok: true, welcomeSkipped: true });
      }
      const user = await Users.findById(_u.id);
      const displayName = member.nickname || user?.displayName || user?.username || 'yeni üye';
      const text = (config.welcomeMessage || 'Sunucuya hoş geldin, {user}! 👋')
        .replace('{user}', `@${displayName}`)
        .replace('{server}', (await Servers.findById(sid))?.name || 'sunucu');

      const welcome = await Messages.create({
        _id: uuidv4(),
        channelId: config.welcomeChannelId,
        serverId: sid,
        userId: 'system',
        username: 'Bridge',
        displayName: 'Bridge',
        content: text,
        type: 'welcome',
        createdAt: Date.now(),
      });

      // Broadcast the stored row (history cache, open channel, watchers).
      try {
        await publishPersistedMessage(getIo(), welcome);
      } catch (err) { logger.warn({ err, event: 'onboarding.fetch.error' }, 'Onboarding fetch failed silently'); }
    } catch (err) { logger.warn({ err, event: 'onboarding.fetch.error' }, 'Onboarding fetch failed silently'); }
  }

  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
