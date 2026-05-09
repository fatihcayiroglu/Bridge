// @ts-nocheck
const logger = require('./logger');
const { randomUUID } = require('crypto');
// server/lib/notifications.js
// Mention detection, notification queue, push support
//
// KULLANIM (socket handler'dan):
//   const { processNotifications } = require('../lib/notifications');
//   await processNotifications(msg, io, socketUsers);

const { cache } = require('./redisAdapter');
const {
  Users,
  Channels,
  Members,
  Notifications,
} = require('../db/repositories');

// ── MENTION PATTERN ──────────────────────────────────────────
// @kullaniciadi veya @everyone / @here
const MENTION_REGEX = /@([a-zA-Z0-9_]+)/g;
const EVERYONE_REGEX = /@(everyone|here)/;

// ── ANA FONKSİYON ────────────────────────────────────────────
async function processNotifications(msg, io, socketUsers) {
  try {
    const mentions = extractMentions(msg.content || '');
    const isEveryoneMention = EVERYONE_REGEX.test(msg.content || '');

    if (!mentions.length && !isEveryoneMention) return;

    // Kanal üyelerini bul
    const channel = await Channels.findById(msg.channelId);
    if (!channel) return;

    let targetUserIds = [];

    if (isEveryoneMention) {
      // Tüm sunucu üyeleri
      const members = await Members.findByServer(msg.serverId);
      targetUserIds = members.map(m => m.userId).filter(id => id !== msg.userId);
    } else {
      // Mention edilen kullanıcıları bul
      const users = await Users.findByUsernames(mentions);
      const memberUserIds = new Set(
        (await Members.findByServer(msg.serverId)).map(m => m.userId)
      );
      targetUserIds = users
        .filter(u => memberUserIds.has(u._id) && u._id !== msg.userId)
        .map(u => u._id);
    }

    if (!targetUserIds.length) return;

    // Toplu veri çek — N+1 sorgu yerine tek seferde
    const [notifPrefsRows, usernameRows] = await Promise.all([
      Notifications.prefsFind({ userId: { $in: targetUserIds }, channelId: msg.channelId }).catch(() => []) ?? [],
      Users.findByIds(targetUserIds),
    ]);

    // Map oluştur: userId → pref level ve username
    const prefMap = new Map();
    for (const p of (notifPrefsRows || [])) prefMap.set(p.userId, p.level);

    const usernameMap = new Map();
    for (const u of usernameRows) usernameMap.set(u._id, (u.username || '').toLowerCase());

    // Her hedef kullanıcı için notif oluştur
    const notifPromises = targetUserIds.map(async (userId) => {
      // Bildirim tercihi kontrol et (cache + batch'ten)
      const pref = prefMap.get(userId) || 'all';
      if (pref === 'mute') return;
      if (pref === 'mentions' && !isEveryoneMention && !mentions.includes(usernameMap.get(userId) || '')) return;

      // Gerçek zamanlı socket bildirimi
      deliverRealtimeNotif(userId, msg, socketUsers, io);

      // Push bildirimi (FCM/VAPID)
      await deliverPushBatched(userId, msg);

      // Okunmamış sayacını artır
      await incrementUnread(userId, msg.channelId);
    });

    await Promise.allSettled(notifPromises);
  } catch (err) {
    logger.error('[Notifications] Error:', err.message);
  }
}

// ── MENTION EXTRACTION ───────────────────────────────────────
function extractMentions(content) {
  const mentions = [];
  let match;
  const re = new RegExp(MENTION_REGEX.source, 'g');
  while ((match = re.exec(content)) !== null) {
    if (!['everyone', 'here'].includes(match[1])) {
      mentions.push(match[1].toLowerCase());
    }
  }
  return [...new Set(mentions)];
}

// ── REALTIME SOCKEt BİLDİRİMİ ────────────────────────────────
function deliverRealtimeNotif(userId, msg, socketUsers, io) {
  for (const [socketId, su] of socketUsers) {
    if (su.id === userId) {
      io.to(socketId).emit('notification:mention', {
        type:        'mention',
        messageId:   msg._id,
        channelId:   msg.channelId,
        serverId:    msg.serverId,
        fromUser:    msg.displayName,
        fromUserId:  msg.userId,
        preview:     (msg.content || '').slice(0, 100),
        createdAt:   msg.createdAt,
      });
    }
  }
}

// ── PUSH BİLDİRİMİ ───────────────────────────────────────────
const { sendPushToUser } = require('./pushSender');

async function deliverPushNotif(userId, msg) {
  try {
    const payload = {
      title: `${msg.displayName} seni mention etti`,
      body:  (msg.content || '').slice(0, 120),
      icon:  '/icon-192.png',
      badge: '/badge-72.png',
      data:  {
        type:      'mention',
        channelId: msg.channelId,
        serverId:  msg.serverId,
        messageId: msg._id,
      },
    };
    await sendPushToUser(userId, payload);
  } catch { /* push hatası kritik değil */ }
}

// ── OKUNMAMIŞ SAYACI ─────────────────────────────────────────
async function incrementUnread(userId, channelId) {
  const existing = await Notifications.unreadFindOne({ userId, channelId });
  if (existing) {
    await Notifications.unreadUpdate({ userId, channelId }, { $set: { count: (existing.count || 0) + 1, updatedAt: Date.now() } });
  } else {
    await Notifications.unreadInsert({ userId, channelId, count: 1, createdAt: Date.now(), updatedAt: Date.now() });
  }
}

async function clearUnread(userId, channelId) {
  try {
    await Notifications.unreadUpdate({ userId, channelId }, { $set: { count: 0, updatedAt: Date.now() } });
  } catch {}
}

async function getUnreadCounts(userId) {
  try {
    const rows = (await Notifications.unreadFind({ userId, count: { $gt: 0 } }).catch(() => [])) ?? [];
    return rows.reduce((acc, r) => { acc[r.channelId] = r.count; return acc; }, {});
  } catch { return {}; }
}

// ── YARDIMCI ─────────────────────────────────────────────────
async function getNotifPref(userId, channelId) {
  const cacheKey = `notifpref:${userId}:${channelId}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;
  const pref = await Notifications.findPref(userId, channelId);
  const level = pref?.level || 'all';
  await cache.set(cacheKey, level, 120); // 2 dakika cache
  return level;
}

async function getUsernameById(userId) {
  const cacheKey = `username:${userId}`;
  const cached = await cache.get(cacheKey);
  if (cached) return cached;
  const user = await Users.findById(userId);
  const username = user?.username?.toLowerCase() || '';
  await cache.set(cacheKey, username, 300);
  return username;
}

// ── PUSH SUBSCRIPTION ROUTES ─────────────────────────────────
const express = require('express');
const pushRouter = express.Router();
const { authMiddleware } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

pushRouter.post('/subscribe', authMiddleware, asyncHandler(async (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Invalid subscription' });

  const existing = await Notifications.findPushSubscriptionForUserEndpoint(req.user.id, subscription.endpoint);
  if (!existing) {
    await Notifications.insertPushSubscription({
      _id:       randomUUID(),
      userId:    req.user.id,
      endpoint:  subscription.endpoint,
      keys:      subscription.keys || {},
      createdAt: Date.now(),
    });
  }
  res.json({ subscribed: true });
}));

pushRouter.delete('/unsubscribe', authMiddleware, asyncHandler(async (req, res) => {
  const { endpoint } = req.body;
  await Notifications.removePushSubscriptionWhere({ userId: req.user.id, endpoint });
  res.json({ unsubscribed: true });
}));

pushRouter.get('/vapid-key', (req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

// POST /api/push/register-native
// Capacitor bridge (mobile/capacitor-bridge.js) native push token kaydı.
// iOS/Android cihazlardan APNs/FCM token'ı kabul eder.
pushRouter.post('/register-native', authMiddleware, asyncHandler(async (req, res) => {
  const { token, platform } = req.body;
  const userId = req.user.id;

  if (!token || typeof token !== 'string')
    return res.status(400).json({ error: 'token gerekli' });

  const plat = ['ios', 'android'].includes(platform) ? platform : 'unknown';
  await Notifications.upsertNativeToken(userId, plat, token);
  res.json({ ok: true });
}));

module.exports = { processNotifications, extractMentions, clearUnread, getUnreadCounts, pushRouter };

// ── v43: NOTIFICATION BATCHING ────────────────────────────────
// Aynı kanaldaki birden fazla mention'ı grupla: "5 yeni mesaj #genel"
const _pendingPush = new Map(); // key: `${userId}:${channelId}` → { timer, msgs[] }
const PUSH_DEBOUNCE_MS = 3000; // 3 saniye bekle, sonra tek bildirim gönder

async function deliverPushBatched(userId, msg) {
  const key = `${userId}:${msg.channelId}`;

  if (_pendingPush.has(key)) {
    const pending = _pendingPush.get(key);
    clearTimeout(pending.timer);
    pending.msgs.push(msg);
  } else {
    _pendingPush.set(key, { msgs: [msg], timer: null });
  }

  const pending = _pendingPush.get(key);
  pending.timer = setTimeout(async () => {
    _pendingPush.delete(key);
    const msgs  = pending.msgs;
    const count = msgs.length;
    const last  = msgs[msgs.length - 1];

    let title, body;
    if (count === 1) {
      title = `${last.displayName || last.username} seni mention etti`;
      body  = (last.content || '').slice(0, 120);
    } else {
      // Channel adını bul
      let channelName = msg.channelId;
      try {
        const ch = await Channels.findById(msg.channelId);
        if (ch) channelName = `#${ch.name}`;
      } catch {}
      title = `${count} yeni mention — ${channelName}`;
      body  = msgs.slice(-3).map(m => `${m.displayName || m.username}: ${(m.content||'').slice(0,60)}`).join('\n');
    }

    try {
      await sendPushToUser(userId, {
        title, body,
        icon:  '/icon-192.png',
        badge: '/badge-72.png',
        data:  { type: 'mention', channelId: msg.channelId, serverId: msg.serverId },
      });
    } catch {}
  }, PUSH_DEBOUNCE_MS);
}

// processNotifications'ı deliverPushBatched kullanacak şekilde patch et
// (mevcut deliverPushNotif yerine)
const _origDeliver = deliverPushNotif; // mevcut fonksiyon referansı korunur
// Dışa aktar — socket handlers bunu kullanabilir
module.exports.deliverPushBatched = deliverPushBatched;
export {};
