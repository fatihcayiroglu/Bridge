// server/routes/activity.js Aktivite Sistemi
// Kullanıcıların ne dinlediği, ne oynadığı, ne izlediği
// Discord'da Nitro ile sınırlı → Bridge'de tamamen ücretsiz

const express      = require('express');
const router       = express.Router();
const { Users, Members } = require('../db/repositories');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { cache }    = require('../lib/redisAdapter');
const { limits }   = require('../middleware/rateLimit');

// ── AKTİVİTE TİPLERİ ─────────────────────────────────────────
const ACTIVITY_TYPES = {
  PLAYING:   'playing',   // 🎮 Oyun oynuyor
  LISTENING: 'listening', // 🎵 Müzik dinliyor
  WATCHING:  'watching',  // 📺 İzliyor
  STREAMING: 'streaming', // 🔴 Yayın yapıyor
  CODING:    'coding',    // 💻 Kod yazıyor
  READING:   'reading',   // 📚 Okuyor
  CUSTOM:    'custom',    // ✏️ Özel durum
};

const ACTIVITY_ICONS = {
  playing:   '🎮',
  listening: '🎵',
  watching:  '📺',
  streaming: '🔴',
  coding:    '💻',
  reading:   '📚',
  custom:    '✏️',
};

// ─────────────────────────────────────────────────────────────
// PATCH /api/activity — aktivite güncelle/sil
// Body: { type, name, detail, url } | null (temizlemek için)
// ─────────────────────────────────────────────────────────────
router.patch('/', authMiddleware, limits.settings(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { type, name, detail, url, emoji } = req.body || {};

  // null body → aktiviteyi temizle
  if (!req.body || (!type && !name)) {
    await cache.delete(`activity:${_u.id}`);
    await Users.update(_u.id, { activity: null, activityUpdatedAt: Date.now() });

    // Socket yayını: aktivite silindi
    const app = require('../index').app;
    const io  = app?.get?.('io');
    if (io) {
      const memberships = await Members.findByUser(_u.id);
      const serverIds   = memberships.map(m => m.serverId);
      io.to(serverIds).emit('user:activity', { userId: _u.id, activity: null });
    }

    return res.json({ activity: null });
  }

  // Validasyon
  if (type && !Object.values(ACTIVITY_TYPES).includes(type)) {
    return res.status(400).json({ error: 'Invalid activity type', valid: Object.values(ACTIVITY_TYPES) });
  }
  if (name && name.length > 64) return res.status(400).json({ error: 'name max 64 chars' });
  if (detail && detail.length > 128) return res.status(400).json({ error: 'detail max 128 chars' });

  const activity = {
    type:      type || 'custom',
    name:      name?.trim()   || '',
    detail:    detail?.trim() || '',
    url:       url?.trim()    || '',
    emoji:     emoji?.trim()  || ACTIVITY_ICONS[type] || '✏️',
    startedAt: Date.now(),
  };

  // DB + cache güncelle (cache: 1 saat, sonra otomatik temizlenir)
  await cache.set(`activity:${_u.id}`, activity, 3600);
  await Users.update(_u.id, { activity, activityUpdatedAt: Date.now() });

  // Socket yayını: üye olduğu tüm sunuculara gönder
  try {
    const app = require('../index').app;
    const io  = app?.get?.('io');
    if (io) {
      const memberships = await Members.findByUser(_u.id);
      const serverIds   = memberships.map(m => m.serverId);
      io.to(serverIds).emit('user:activity', { userId: _u.id, activity });
    }
  } catch { /* IO opsiyonel */ }

  res.json({ activity });
}));

// ─────────────────────────────────────────────────────────────
// GET /api/activity/:userId — bir kullanıcının aktivitesini al
// ─────────────────────────────────────────────────────────────
router.get('/:userId', authMiddleware, asyncHandler(async (req, res) => {
  const { userId } = req.params;

  // Cache'den dene
  const cached = await cache.get(`activity:${userId}`);
  if (cached) return res.json({ activity: cached, cached: true });

  // DB'den al
  const user = await Users.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Aktivite 4 saatten eskiyse temizle
  if (user.activity && user.activityUpdatedAt) {
    const age = Date.now() - user.activityUpdatedAt;
    if (age > 4 * 60 * 60 * 1000) {
      await Users.update(userId, { activity: null });
      return res.json({ activity: null });
    }
  }

  res.json({ activity: user.activity || null });
}));

// ─────────────────────────────────────────────────────────────
// GET /api/activity/server/:serverId — sunucudaki aktif kullanıcılar
// ─────────────────────────────────────────────────────────────
router.get('/server/:serverId', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { serverId } = req.params;

  // Üyelik kontrolü
  const membership = await Members.findOne(_u.id, serverId);
  if (!membership) return res.status(403).json({ error: 'Not a member' });

  // Tüm üyelerin aktivitelerini çek
  const members = await Members.findByServer(serverId);
  const userIds = members.map(m => m.userId);
  const users   = await Users.findByIds(userIds);

  const cutoff = Date.now() - 4 * 60 * 60 * 1000; // 4 saat
  const active = users
    .filter(u => u.activity && u.activityUpdatedAt > cutoff)
    .map(u => ({
      userId:      u._id,
      displayName: u.displayName || u.username,
      avatarUrl:   u.avatarUrl,
      avatarColor: u.avatarColor,
      activity:    u.activity,
    }));

  res.json({ active, count: active.length });
}));

// ─────────────────────────────────────────────────────────────
// GET /api/activity/types — desteklenen aktivite tipleri
// ─────────────────────────────────────────────────────────────
router.get('/meta/types', (req, res) => {
  res.json({
    types: Object.entries(ACTIVITY_TYPES).map(([key, value]) => ({
      key,
      value,
      icon: ACTIVITY_ICONS[value],
      label: {
        playing:   'Oynuyor',
        listening: 'Dinliyor',
        watching:  'İzliyor',
        streaming: 'Yayın yapıyor',
        coding:    'Kod yazıyor',
        reading:   'Okuyor',
        custom:    'Özel',
      }[value],
    })),
  });
});

module.exports = { router, ACTIVITY_TYPES, ACTIVITY_ICONS };
export {};
