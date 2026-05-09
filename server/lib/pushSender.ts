// @ts-nocheck
// server/lib/pushSender.js.1
// Web Push (VAPID) + FCM HTTP v1 (OAuth2) + APNs via FCM
//
// FCM KURULUM:
//   1. Firebase Console → Project Settings → Service Accounts → Generate new private key
//   2. JSON dosyasını güvenli bir yere koy (git'e ekleme!)
//   3. FCM_SERVICE_ACCOUNT_PATH=/path/to/serviceAccount.json  veya
//      FCM_SERVICE_ACCOUNT_JSON=<JSON içeriği> (tek satır) env değişkeni olarak set et
//   4. FCM_PROJECT_ID=your-project-id env değişkenini set et
//
// LEGACY FCM (fcm.googleapis.com/fcm/send) artık kullanılmıyor — Temmuz 2025'te kapandı.

'use strict';
const logger = require('./logger');

const {
  Notifications,
  Members,
  Channels,
  Messages,
  Dms,
} = require('../db/repositories');

// ── WEB PUSH (VAPID) ──────────────────────────────────────────
let webpush = null;
function getWebPush() {
  if (webpush) return webpush;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return null;
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@bridge.app',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    return webpush;
  } catch { return null; }
}

// ── Retry helper ──────────────────────────────────────────────
async function _withRetry(fn, maxAttempts = 3, baseDelayMs = 500) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Kalıcı hatalar için retry yok (stale subscription, auth hatası)
      const code = err.statusCode || err.status;
      if (code === 410 || code === 404 || code === 401 || code === 400) throw err;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1); // exponential backoff
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

async function sendWebPush(subscription, payload) {
  const wp = getWebPush();
  if (!wp) return;
  try {
    await _withRetry(() => wp.sendNotification(subscription, JSON.stringify(payload)));
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      await Notifications.removePushSubscriptionWhere({ endpoint: subscription.endpoint }, { multi: false });
    } else {
      logger.warn({ err: err.message, endpoint: subscription.endpoint, event: 'push.webpush.failed' }, 'Web push gönderilemedi.');
    }
  }
}

// ── FCM HTTP v1 — OAuth2 tabanlı (güncel API) ─────────────────
// Token cache: her 55 dakikada bir yenile (token 60 dakika geçerli)
let _fcmAccessToken = null;
let _fcmTokenExpiry = 0;
let _fcmRefreshPromise = null; // mutex: eşzamanlı refresh yarışını önler

async function getFcmAccessToken() {
  if (_fcmAccessToken && Date.now() < _fcmTokenExpiry) return _fcmAccessToken;
  // Refresh devam ediyorsa aynı promise'i bekle (thundering herd önleme)
  if (_fcmRefreshPromise) return _fcmRefreshPromise;

  _fcmRefreshPromise = (async () => {
    let serviceAccount = null;
    if (process.env.FCM_SERVICE_ACCOUNT_JSON) {
      try { serviceAccount = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON); } catch {}
    } else if (process.env.FCM_SERVICE_ACCOUNT_PATH) {
      try {
        const fs = require('fs');
        serviceAccount = JSON.parse(fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT_PATH, 'utf8'));
      } catch {}
    }

    if (!serviceAccount?.private_key || !serviceAccount?.client_email) {
      _fcmRefreshPromise = null;
      return null;
    }

    try {
      const crypto  = require('crypto');
      const now     = Math.floor(Date.now() / 1000);
      const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
      const claim   = Buffer.from(JSON.stringify({
        iss:   serviceAccount.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud:   'https://oauth2.googleapis.com/token',
        iat:   now,
        exp:   now + 3600,
      })).toString('base64url');

      const sigInput  = `${header}.${claim}`;
      const sign      = crypto.createSign('RSA-SHA256');
      sign.update(sigInput);
      const signature = sign.sign(serviceAccount.private_key, 'base64url');
      const jwt       = `${sigInput}.${signature}`;

      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
          assertion:  jwt,
        }),
      });

      if (!res.ok) {
        logger.warn('[FCM] OAuth2 token alınamadı:', res.status);
        return null;
      }

      const json = await res.json();
      _fcmAccessToken = json.access_token;
      _fcmTokenExpiry = Date.now() + 55 * 60 * 1000;
      return _fcmAccessToken;
    } catch (err) {
      logger.warn('[FCM] Token imzalama hatası:', err.message);
      return null;
    } finally {
      _fcmRefreshPromise = null; // mutex serbest bırak
    }
  })();

  return _fcmRefreshPromise;
}

async function sendFCM(fcmToken, payload) {
  const projectId = process.env.FCM_PROJECT_ID;
  if (!projectId) return;

  const accessToken = await getFcmAccessToken();
  if (!accessToken) return;

  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  const message = {
    token: fcmToken,
    notification: {
      title: payload.title,
      body:  payload.body,
    },
    // FCM data fields must all be strings
    data: Object.fromEntries(
      Object.entries(payload.data || {}).map(([k, v]) => [k, String(v)])
    ),
    android: {
      notification: {
        icon:               'ic_stat_bridge',
        color:              '#5865f2',
        notification_count: payload.badge || 0,
        channel_id:         'bridge_default',
      },
      priority: 'high',
    },
    apns: {
      payload: {
        aps: {
          badge:               payload.badge || 0,
          sound:               'default',
          'content-available': 1,
        },
      },
    },
  };

  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ message }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 404 || body.includes('UNREGISTERED')) {
        // Geçersiz token — DB'den temizle
        await Notifications.removeNativeTokenWhere({ token: fcmToken });
        await Notifications.removeFcmTokenWhere({ token: fcmToken });
      } else {
        logger.warn(`[FCM v1] Send error ${res.status}:`, body.slice(0, 200));
      }
    }
  } catch (err) {
    logger.warn('[FCM v1] Fetch error:', err.message);
  }
}

// ── BADGE COUNT ───────────────────────────────────────────────
// Her kanal için ayrı COUNT sorgusu yapmak yerine tüm veriyi tek seferde
// çekip JS'de topluyoruz — 100+ kanallı sunucularda belirgin fark yaratır.
async function getUnreadCount(userId) {
  try {
    let total = 0;

    // ── DM okunmamışları ──────────────────────────────────────
    const dmConvs = await Dms.findConversationsByUser(userId).catch(() => []) ?? [];

    if (dmConvs.length > 0) {
      const convIds = dmConvs.map(c => c._id);
      const dmMsgs = await Dms.findMessagesWhere({
        dmId:   { $in: convIds },
        userId: { $ne: userId },
      }).catch(() => []) ?? [];

      for (const conv of dmConvs) {
        const lastRead = conv.lastRead?.[userId] || 0;
        total += dmMsgs.filter(m => m.dmId === conv._id && m.createdAt > lastRead).length;
      }
    }

    // ── Sunucu kanalları okunmamışları ────────────────────────
    const memberships = await Members.findByUser(userId).catch(() => []) ?? [];

    if (memberships.length > 0) {
      const serverIds = memberships.map(m => m.serverId);

      const allChannels = await Channels.findWhere({
        serverId: { $in: serverIds },
        type:       'text',
      }).catch(() => []) ?? [];

      if (allChannels.length > 0) {
        const channelIds = allChannels.map(c => c._id);

        const prefs = await Notifications.prefsFind({
          userId,
          channelId: { $in: channelIds },
        }).catch(() => []) ?? [];

        const mutedSet = new Set(
          prefs.filter(p => p.level === 'mute').map(p => p.channelId)
        );

        const activeChannelIds = channelIds.filter(id => !mutedSet.has(id));
        if (activeChannelIds.length > 0) {
          const msgs = await Messages.messagesFind({
            channelId: { $in: activeChannelIds },
            userId:    { $ne: userId },
          }).catch(() => []) ?? [];

          for (const ch of allChannels) {
            if (mutedSet.has(ch._id)) continue;
            const lastRead = ch.lastRead?.[userId] || 0;
            total += msgs.filter(m => m.channelId === ch._id && m.createdAt > lastRead).length;
          }
        }
      }
    }

    return Math.min(total, 99);
  } catch {
    return 0;
  }
}

// ── MAIN: SEND TO USER ────────────────────────────────────────
async function sendPushToUser(userId, payload) {
  try {
    const badge = await getUnreadCount(userId);

    // E2EE mesajları için push içeriğini sanitize et:
    // Şifreli ciphertext'i asla push payload'una koyma — sadece "Yeni mesajınız var" gönder.
    const isE2E = typeof payload.body === 'string' && payload.body.startsWith('🔒e2e:');
    const enrichedPayload = {
      ...payload,
      badge,
      ...(isE2E ? {
        body: '🔒 Şifreli mesaj',
        // title ve diğer alanlar korunur
      } : {}),
    };

    // Web push (VAPID — tarayıcı / PWA)
    const webSubs = await Notifications.findPushSubscriptionsForUser(userId);
    await Promise.allSettled(webSubs.map(sub =>
      sendWebPush({ endpoint: sub.endpoint, keys: sub.keys }, enrichedPayload)
    ));

    // FCM HTTP v1 (iOS + Android native — nativePushTokens collection)
    const nativeTokens = await Notifications.findNativeTokensForUser(userId);
    await Promise.allSettled(nativeTokens.map(r => sendFCM(r.token, enrichedPayload)));

    // Legacy fcmTokens collection fallback
    const legacyTokens = await Notifications.findFcmTokensForUser(userId);
    await Promise.allSettled(legacyTokens.map(r => sendFCM(r.token, enrichedPayload)));
  } catch (err) {
    logger.warn('[pushSender] sendPushToUser error:', err.message);
  }
}

// Badge sıfırla — kullanıcı uygulamayı açtığında çağrılır
// NOT: notification alanı gönderilmiyor — boş title/body iOS'ta görünür bildirim
// oluşturur. Bunun yerine data-only mesaj + apns content-available kullanılıyor.
async function clearBadge(userId) {
  try {
    const projectId = process.env.FCM_PROJECT_ID;
    if (!projectId) return;
    const accessToken = await getFcmAccessToken();
    if (!accessToken) return;

    const rows = await Notifications.findNativeTokensForUser(userId);
    const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

    await Promise.allSettled(rows.map(async r => {
      const message = {
        token: r.token,
        // notification bloğu yok — görünür bildirim oluşturulmaz
        data: { badge: '0', type: 'badge_clear' },
        android: { priority: 'normal' },
        apns: {
          payload: {
            aps: {
              badge: 0,
              'content-available': 1,
            },
          },
          headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
        },
      };
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message }),
        });
        if (!res.ok) {
          const body = await res.text();
          if (res.status === 404 || body.includes('UNREGISTERED')) {
            await Notifications.removeNativeTokenWhere({ token: r.token });
          }
        }
      } catch (err) {
        logger.warn('[pushSender] clearBadge send error:', err.message);
      }
    }));
  } catch (err) {
    logger.warn('[pushSender] clearBadge error:', err.message);
  }
}

module.exports = { sendPushToUser, sendWebPush, sendFCM, getUnreadCount, clearBadge };
export {};
