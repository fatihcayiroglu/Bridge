// server/routes/notificationPrefs.ts  (Sprint 91)
// Granüler bildirim tercihleri — kanal & sunucu seviyesi
// Sprint 105: OpenAPI annotations eklendi

/**
 * @openapi
 * /notification-prefs:
 *   get:
 *     tags: [Notifications]
 *     summary: Kullanıcının bildirim tercihlerini getir
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: Bildirim tercihleri }
 *   put:
 *     tags: [Notifications]
 *     summary: Kanal bazlı bildirim tercihini güncelle
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [channelId, level]
 *             properties:
 *               channelId: { type: string }
 *               level: { type: string, enum: [all, mentions, none] }
 *     responses:
 *       200: { description: Tercih güncellendi }
 * /notification-prefs/server:
 *   put:
 *     tags: [Notifications]
 *     summary: Sunucu bazlı bildirim tercihini güncelle
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [serverId, level]
 *             properties:
 *               serverId: { type: string }
 *               level: { type: string, enum: [all, mentions, none] }
 *     responses:
 *       200: { description: Tercih güncellendi }
 * /notification-prefs/{channelId}:
 *   delete:
 *     tags: [Notifications]
 *     summary: Kanal bildirim tercihini sıfırla
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { name: channelId, in: path, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: Tercih silindi }
 */
//
// GET  /api/notification-prefs?serverId=xxx    → tüm kanal tercihleri + server level
// PUT  /api/notification-prefs                 → kanal tercihi kaydet
// PUT  /api/notification-prefs/server          → sunucu-seviye tercih kaydet
// DELETE /api/notification-prefs/:channelId    → tercihi sil (varsayılana dön)

import express from 'express';
import { authMiddleware} from '../middleware/auth';
import { Notifications }              from '../db/repositories';
import { limits }                     from '../middleware/rateLimit';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router = express.Router();

const VALID_LEVELS = new Set(['all', 'mentions', 'mute', 'default']);

// ── GET ──────────────────────────────────────────────────────────────────────

router.get('/', authMiddleware, async (req, res) => {
  const { user } = castAuthed(req);
  const { serverId } = req.query as { serverId?: string };

  if (!serverId) return res.status(400).json({ error: 'serverId required' });

  try {
    // Fetch all channel prefs for user in this server's channels
    const allPrefs = await Notifications.findPrefsForUserInServer?.(user.id, serverId)
      ?? await Notifications.findPrefsForUser?.(user.id)
      ?? [];

    // Server-level pref
    const serverPref = await Notifications.findServerPref?.(user.id, serverId);

    return res.json({
      channels:    allPrefs,
      serverLevel: serverPref?.level ?? 'default',
    });
  } catch {
    return res.json({ channels: [], serverLevel: 'default' });
  }
});

// ── PUT /api/notification-prefs (channel level) ──────────────────────────────

router.put('/', authMiddleware, limits.messages(), async (req, res) => {
  const { user } = castAuthed(req);
  const { channelId, level, muteUntil } = req.body as {
    channelId?: string;
    level?:     string;
    muteUntil?: number | null;
  };

  if (!channelId || typeof channelId !== 'string')
    return res.status(400).json({ error: 'channelId required' });
  if (!level || !VALID_LEVELS.has(level))
    return res.status(400).json({ error: 'Invalid level. Must be: all | mentions | mute | default' });
  if (muteUntil !== undefined && muteUntil !== null && typeof muteUntil !== 'number')
    return res.status(400).json({ error: 'muteUntil must be a timestamp or null' });

  const fields: Record<string, unknown> = {
    level,
    updatedAt: Date.now(),
  };
  if (level === 'mute') {
    fields.muteUntil = muteUntil ?? null; // null = forever
  } else {
    fields.muteUntil = null;
  }

  await Notifications.upsertPref(user.id, channelId, fields);

  return res.json({ channelId, level, muteUntil: fields.muteUntil, updatedAt: fields.updatedAt });
});

// ── PUT /api/notification-prefs/server ───────────────────────────────────────

router.put('/server', authMiddleware, limits.messages(), async (req, res) => {
  const { user } = castAuthed(req);
  const { serverId, level } = req.body as { serverId?: string; level?: string };

  if (!serverId) return res.status(400).json({ error: 'serverId required' });
  if (!level || !VALID_LEVELS.has(level))
    return res.status(400).json({ error: 'Invalid level' });

  // Store server-level pref using channelId = `server:${serverId}` as namespace key
  await Notifications.upsertPref(user.id, `server:${serverId}`, {
    level,
    updatedAt: Date.now(),
    isServerLevel: true,
    serverId,
  });

  return res.json({ serverId, level });
});

// ── DELETE /api/notification-prefs/:channelId ────────────────────────────────

router.delete('/:channelId', authMiddleware, async (req, res) => {
  const { user } = castAuthed(req);
  const { channelId } = req.params as { channelId: string };

  try {
    await Notifications.deletePref?.(user.id, channelId);
  } catch { /* pref may not exist */ }

  return res.json({ deleted: true, channelId });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
