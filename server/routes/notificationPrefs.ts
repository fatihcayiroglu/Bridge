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
 *               level: { type: string, enum: [all, mentions, mute, default] }
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
 *               level: { type: string, enum: [all, mentions, mute, default] }
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
import { effectiveNotificationPref, isMuted, normalizeNotificationLevel } from '../lib/notificationMute';
import { authMiddleware} from '../middleware/auth';
import { Notifications, Channels, Members } from '../db/repositories';
import { limits }                     from '../middleware/rateLimit';
import { resolvePermissions, hasPermission, PERMS, canViewChannel, viewableChannelIds } from '../lib/permissions';

import { safeCastAuthed as castAuthed } from '../lib/authSafe';
import { normalizeNotificationWatchWords } from '../lib/notificationWatchWords';
const router = express.Router();

const VALID_LEVELS = new Set(['all', 'mentions', 'mute', 'default']);

/** Okunmamış özetinde döndürülecek en fazla kanal sayısı. */
const UNREAD_MAX_CHANNELS = 200;

// ── GET ──────────────────────────────────────────────────────────────────────

router.get('/', authMiddleware, async (req, res) => {
  const { user } = castAuthed(req);
  const { serverId } = req.query as { serverId?: string };

  if (!serverId || typeof serverId !== 'string') return res.status(400).json({ error: 'serverId required' });

  try {
    // Server-scoped preference reads are tenant data: an old/stale preference
    // must not let a former/non-member probe current channel namespaces.
    if (!await Members.findOne(user.id, serverId)) {
      return res.status(403).json({ error: 'Not a server member' });
    }

    // Fetch all channel prefs for user in this server's channels
    const allPrefs = await Notifications.findPrefsForUserInServer?.(user.id, serverId)
      ?? await Notifications.findPrefsForUser?.(user.id)
      ?? [];

    // Server-level pref
    const serverPref = await Notifications.findServerPref?.(user.id, serverId);
    const watchWords = await Notifications.listWatchWords(user.id, serverId);

    const safePrefs = allPrefs.map((pref) => ({
      ...pref,
      level: normalizeNotificationLevel(pref.level, true),
    }));

    return res.json({
      channels:    safePrefs,
      serverLevel: serverPref ? normalizeNotificationLevel(serverPref.level, true) : 'default',
      serverMuteUntil: serverPref?.muteUntil ?? null,
      watchWords,
    });
  } catch {
    // Preference state is policy, not optional decoration. Returning synthetic
    // defaults would falsely claim the user's persisted settings are known.
    return res.status(503).json({ error: 'Notification preferences unavailable' });
  }
});

// ── GET /api/notification-prefs/unread ───────────────────────────────────────
/**
 * Çağıranın okunmamış özeti (gelen kutusu için kanonik veri).
 *
 * `unread_counts` tablosu ZATEN doluyordu (lib/notifications.ts:97
 * `incrementUnread`) ama okuma ucu YOKTU; sayaçlar erişilemiyordu. Burada
 * İKİNCİ bir okunmamış sistemi KURULMAZ — kanonik tablo okunur.
 *
 * ── GÜVENLİK: KANAL GÖRÜNÜRLÜĞÜ ─────────────────────────────────────────────
 * Sayaçlar `(userId, channelId)` ile tutulur ve kullanıcı bir kanalı GÖRME
 * yetkisini SONRADAN kaybetmiş olabilir (C2 kanal override'ları, rol değişimi).
 * Ham liste döndürmek, göremediği kanalların VARLIĞINI ve mesaj HACMİNİ ele
 * verirdi — Search'te kapatılan sızıntının aynısı. Bu yüzden her kanal için
 * `VIEW_CHANNELS` çözümlenir; çözülemeyen/reddedilen kanal ELENİR (fail-closed).
 */
router.get('/unread', authMiddleware, async (req, res) => {
  const { user } = castAuthed(req);

  try {
    const rows = (await Notifications.unreadFind?.({ userId: user.id })) ?? [];
    const positive = (rows as Array<{ channelId?: unknown; count?: unknown }>)
      .filter((r) => Number(r.count) > 0)
      .slice(0, UNREAD_MAX_CHANNELS);

    if (!positive.length) return res.json({ channels: [], total: 0 });

    // Kanal → sunucu eşlemesi: izin çözümü serverId gerektirir.
    const ids  = [...new Set(positive.map((r) => String(r.channelId ?? '')).filter(Boolean))];
    const chans = ids.length ? await Channels.findWhere({ _id: { $in: ids } }) : [];
    const serverOf = new Map<string, string>(
      (chans as Array<{ _id?: unknown; serverId?: unknown }>)
        .map((c) => [String(c._id ?? ''), String(c.serverId ?? '')]),
    );

    // ── SESSIZE ALMA TERCIHLERI: N SORGU DEGIL, TEK SORGU ────────────────
    // OLCULDU (v1.123, gercek PostgreSQL): bu uc kanal basina BIR tercih
    // sorgusu yapiyordu ve maliyet dogrusal buyuyordu. Tercihler kullanici
    // basina TEK seferde okunur; `isMuted` karari degismez (ayni tek sahip,
    // lib/notificationMute.ts), yalnizca veri erisimi toplu hale gelir.
    const prefRows = (await Notifications.findPrefsForUser?.(user.id)) ?? [];
    const prefByKey = new Map<string, { level?: string | null; muteUntil?: number | null }>();
    for (const pref of (prefRows as Array<{ channelId?: unknown; level?: string | null; muteUntil?: number | null }>)) {
      const key = String(pref.channelId ?? '');
      if (key) prefByKey.set(key, pref);
    }

    const visible: Array<{ channelId: string; count: number }> = [];
    for (const row of positive) {
      const channelId = String(row.channelId ?? '');
      const serverId  = serverOf.get(channelId) ?? '';
      // Kanal silinmiş veya sunucusu çözülemiyorsa GÖSTERİLMEZ.
      if (!channelId || !serverId) continue;

      const perms = await resolvePermissions(user.id, serverId, channelId).catch(() => 0);
      if (!hasPermission(perms, PERMS.VIEW_CHANNELS)) continue;

      // ── SESSIZE ALINMIS KANAL ROZET URETMEZ ──────────────────────────
      // KAPATILAN GERCEK TUTARSIZLIK: sessize alma bildirimlerde, push'ta,
      // yanit dikkatinde ve mention olaylarinda uygulaniyordu; YALNIZCA
      // okunmamis rozeti bunu yok sayiyordu. Kullanici kanali susturuyor,
      // bildirimler kesiliyor, ama rozet dikkat istemeye devam ediyordu.
      //
      // Karar tek sahipten sorulur (lib/notificationMute.ts) — boylece
      // `muteUntil` suresi burada da dogru degerlendirilir.
      const effectivePref = effectiveNotificationPref(
        prefByKey.get(channelId),
        prefByKey.get(`server:${serverId}`),
      );
      if (isMuted(effectivePref)) continue;

      visible.push({ channelId, count: Number(row.count) || 0 });
    }

    return res.json({
      channels: visible,
      total:    visible.reduce((n, c) => n + c.count, 0),
    });
  } catch {
    // Fail-closed: hata durumunda sayaç sızdırmaktansa boş dön.
    return res.json({ channels: [], total: 0 });
  }
});

// ── GET /api/notification-prefs/unread-channels ─────────────────────────────
// Channels with messages the caller has not seen (Final21 Phase 15). Unlike
// /unread (mentions and replies), this is plain activity: the channel name turns
// bold. Snapshot semantics — the client replaces its state with this answer.
//   · only channels the caller can VIEW, per server (fail-closed)
//   · muted channels and muted servers never report activity
//   · `muted` lets the client ignore live `channel:activity` for them too
router.get('/unread-channels', authMiddleware, async (req, res) => {
  const { user } = castAuthed(req);
  const empty = { channels: [], muted: { channels: [], servers: [] } };
  try {
    const now = Date.now();
    const prefRows = (await Notifications.findPrefsForUser?.(user.id)) ?? [];
    const prefByKey = new Map<string, { level?: string | null; muteUntil?: number | null }>();
    const mutedChannels: string[] = [];
    const mutedServers: string[] = [];
    for (const pref of (prefRows as Array<{ channelId?: unknown; level?: string | null; muteUntil?: number | null }>)) {
      const key = String(pref.channelId ?? '');
      if (!key) continue;
      prefByKey.set(key, pref);
      if (!isMuted(pref, now)) continue;
      if (key.startsWith('server:')) mutedServers.push(key.slice('server:'.length));
      else mutedChannels.push(key);
    }

    const rows = await Notifications.findActivityUnreadChannels(user.id);
    const byServer = new Map<string, string[]>();
    for (const row of rows) {
      const list = byServer.get(row.serverId) ?? [];
      list.push(row.channelId);
      byServer.set(row.serverId, list);
    }
    const channels: Array<{ channelId: string; serverId: string }> = [];
    for (const [serverId, channelIds] of byServer) {
      const viewable = await viewableChannelIds(user.id, serverId, channelIds);
      for (const channelId of channelIds) {
        if (!viewable.has(channelId)) continue;
        const effective = effectiveNotificationPref(prefByKey.get(channelId), prefByKey.get(`server:${serverId}`), now);
        if (isMuted(effective, now)) continue;
        channels.push({ channelId, serverId });
      }
    }
    return res.json({ channels, muted: { channels: mutedChannels, servers: mutedServers } });
  } catch {
    // Fail-closed like /unread: no activity is invented, none is leaked.
    return res.json(empty);
  }
});

// ── PUT /api/notification-prefs/keywords ───────────────────────────────────
// Replace the caller's complete watch-word set for one server. Words are
// literal normalized tokens, not regexes, so users cannot create expensive or
// surprising server-side matchers.
router.put('/keywords', authMiddleware, limits.messages(), async (req, res) => {
  const { user } = castAuthed(req);
  const { serverId, keywords } = req.body as { serverId?: unknown; keywords?: unknown };
  if (typeof serverId !== 'string' || !serverId.trim()) {
    return res.status(400).json({ error: 'serverId required' });
  }
  const normalized = normalizeNotificationWatchWords(keywords);
  if (!normalized) {
    return res.status(400).json({ error: 'Watch words must contain at most 10 literal words of 2-32 letters, numbers, _ or -.' });
  }
  if (!await Members.findOne(user.id, serverId)) {
    return res.status(403).json({ error: 'Not a server member' });
  }
  try {
    await Notifications.replaceWatchWords(user.id, serverId, normalized);
    return res.json({ watchWords: normalized });
  } catch {
    return res.status(503).json({ error: 'Notification preferences unavailable' });
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
  if (muteUntil !== undefined && muteUntil !== null
      && (!Number.isSafeInteger(muteUntil) || muteUntil < 0))
    return res.status(400).json({ error: 'muteUntil must be a non-negative safe integer timestamp or null' });

  // Caller-supplied channelId is not authority. Resolve the canonical tenant
  // first, then require CURRENT visibility. This prevents preferences from
  // becoming a cross-tenant channel-existence oracle or stale-membership write.
  const channel = await Channels.findById(channelId).catch(() => null);
  if (!channel) return res.status(404).json({ error: 'Channel not found' });
  const serverId = String((channel as { serverId?: unknown }).serverId ?? '');
  if (!serverId || !await canViewChannel(user.id, serverId, channelId))
    return res.status(403).json({ error: 'No access to channel' });

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
  const { serverId, level, muteUntil } = req.body as {
    serverId?: string; level?: string; muteUntil?: number | null;
  };

  if (!serverId || typeof serverId !== 'string') return res.status(400).json({ error: 'serverId required' });
  if (!level || !VALID_LEVELS.has(level))
    return res.status(400).json({ error: 'Invalid level' });
  if (muteUntil !== undefined && muteUntil !== null
      && (!Number.isSafeInteger(muteUntil) || muteUntil < 0))
    return res.status(400).json({ error: 'muteUntil must be a non-negative safe integer timestamp or null' });

  // Caller-supplied serverId is not authority. Only a current, non-banned
  // member may create/update a server-scoped preference.
  if (!await Members.findOne(user.id, serverId))
    return res.status(403).json({ error: 'Not a server member' });

  // Server-level prefs intentionally reuse channelId as a namespace key.
  // Do NOT persist `serverId` / `isServerLevel`: those columns do not belong
  // to the canonical PostgreSQL contract.
  const fields = {
    level,
    muteUntil: level === 'mute' ? (muteUntil ?? null) : null,
    updatedAt: Date.now(),
  };
  await Notifications.upsertPref(user.id, `server:${serverId}`, fields);

  return res.json({ serverId, level, muteUntil: fields.muteUntil });
});

// ── DELETE /api/notification-prefs/:channelId ────────────────────────────────

router.delete('/:channelId', authMiddleware, async (req, res) => {
  const { user } = castAuthed(req);
  const { channelId } = req.params as { channelId: string };

  try {
    // Removing a missing preference is already idempotent at the repository
    // level. An actual storage failure must not be reported as successful.
    await Notifications.deletePref?.(user.id, channelId);
  } catch {
    return res.status(503).json({ error: 'Notification preferences unavailable' });
  }

  return res.json({ deleted: true, channelId });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
