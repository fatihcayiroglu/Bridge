// server/lib/pushSender.ts — Sprint 65: APNs HTTP/2 direkt entegrasyon + FCM v1
// Web Push (VAPID) + FCM HTTP v1 (OAuth2) + APNs HTTP/2 (p8 key, native)

import logger from './logger';
import { assertUrlIsPublic } from './ssrfGuard';
import { isMuted } from './notificationMute';
import { Notifications, Members, Channels, Messages, Dms } from '../db/repositories';
import * as http2 from 'http2';
import * as fs   from 'fs';
import * as crypto from 'crypto';

// ── Tipler ────────────────────────────────────────────────────
export interface PushPayload {
  title:  string;
  body:   string;
  icon?:  string;
  badge?: string | number;
  data?:  Record<string, unknown>;
  [key: string]: unknown;
}

function normalizePushBadge(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : 0;
  }
  if (typeof value === 'string' && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : 0;
  }
  return 0;
}

export interface WebPushSubscription {
  endpoint: string;
  keys:     Record<string, string>;
}

interface WebPushLib {
  setVapidDetails(subject: string, pubKey: string, privKey: string): void;
  sendNotification(sub: WebPushSubscription, payload: string): Promise<unknown>;
}

interface WebPushError extends Error {
  statusCode?: number;
  status?:     number;
}

interface NativeTokenRow {
  token: string;
  platform?: string;
}

function normalizeWebPushRows(rows: unknown): WebPushSubscription[] {
  if (!Array.isArray(rows)) return [];
  const out: WebPushSubscription[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rec = row as Record<string, unknown>;
    if (typeof rec.endpoint !== 'string' || !rec.endpoint) continue;
    if (!rec.keys || typeof rec.keys !== 'object' || Array.isArray(rec.keys)) continue;
    const keys: Record<string, string> = {};
    let valid = true;
    for (const [key, value] of Object.entries(rec.keys as Record<string, unknown>)) {
      if (typeof value !== 'string') { valid = false; break; }
      keys[key] = value;
    }
    if (valid) out.push({ endpoint: rec.endpoint, keys });
  }
  return out;
}

function normalizeNativeTokenRows(rows: unknown): NativeTokenRow[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row): NativeTokenRow[] => {
    if (!row || typeof row !== 'object') return [];
    const rec = row as Record<string, unknown>;
    if (typeof rec.token !== 'string' || !rec.token) return [];
    return [{ token: rec.token, ...(typeof rec.platform === 'string' ? { platform: rec.platform } : {}) }];
  });
}

// ── webpush lazy-loader ───────────────────────────────────────
let webpush: WebPushLib | null = null;
let _webpushLoading = false;

async function getWebPush(): Promise<WebPushLib | null> {
  if (webpush) return webpush;
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return null;
  if (_webpushLoading) return null;
  _webpushLoading = true;
  try {
    const mod = await import('web-push');
    webpush = (mod.default ?? mod) as unknown as WebPushLib;
    webpush.setVapidDetails(
      process.env.VAPID_SUBJECT || 'mailto:admin@bridge.app',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
  } catch { webpush = null; }
  _webpushLoading = false;
  return webpush;
}

// ── Retry helper ──────────────────────────────────────────────
async function _withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 500,
): Promise<T> {
  let lastErr: WebPushError = new Error('Unknown error');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err as WebPushError;
      const code = lastErr.statusCode ?? lastErr.status;
      if (code === 410 || code === 404 || code === 401 || code === 400) throw lastErr;
      if (attempt < maxAttempts) {
        const delay = baseDelayMs * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

export async function sendWebPush(
  subscription: WebPushSubscription,
  payload: PushPayload,
): Promise<void> {
  const wp = await getWebPush();
  if (!wp) return;

  // ── SSRF: `web-push` KENDI HTTP ISTEGINI YAPAR ────────────────────────────
  //
  // `endpoint` KULLANICIDAN gelir (/api/webpush/subscribe) ve veritabaninda
  // saklanir. `wp.sendNotification()` bu adrese kendi icinde istek atar; bizim
  // `fetchT` guard'imizdan GECMEZ. Yani kimligi dogrulanmis herhangi bir
  // kullanici `https://10.0.0.5/...` gibi bir endpoint kaydedip sunucuyu IC
  // AGA istek atmaya zorlayabilirdi (/api/webpush/test ile tetiklenebilir).
  //
  // Yanit saldirgana DONMEZ (kor SSRF) ve `https:` sarti hedefin TLS
  // konusmasini gerektirir — ama baglanti zamanlamasi ic port taramasi icin
  // guvenilir bir oracle'dir ve ic HTTPS servisleri erisilebilir kalir.
  //
  // Kayit anindaki kontrol tek basina YETMEZ: (a) bu satirdan onceki kayitlar
  // dogrulanmadan yazildi, (b) DNS kayit ile gonderim arasinda yeniden
  // baglanabilir. Bu yuzden dogrulama KULLANIM ANINDA da yapilir.
  try {
    await assertUrlIsPublic(subscription.endpoint);
  } catch (err) {
    logger.warn(
      { endpoint: subscription.endpoint, err: (err as Error).message, event: 'push.webpush.blocked_ssrf' },
      'Push endpoint ic aga isaret ediyor — gonderim engellendi.',
    );
    return;
  }

  try {
    await _withRetry(() => wp.sendNotification(subscription, JSON.stringify(payload)));
  } catch (err) {
    const e = err as WebPushError;
    if (e.statusCode === 410 || e.statusCode === 404) {
      try {
        await Notifications.removePushSubscriptionWhere({ endpoint: subscription.endpoint }, { multi: false });
      } catch (cleanupErr) {
        logger.warn({ endpoint: subscription.endpoint, err: (cleanupErr as Error).message, event: 'push.webpush.cleanup_failed' },
          "Geçersiz web-push aboneliği DB'den kaldırılamadı.");
      }
    } else {
      logger.warn({ err: e.message, endpoint: subscription.endpoint, event: 'push.webpush.failed' }, 'Web push gönderilemedi.');
    }
  }
}

// ── FCM HTTP v1 — OAuth2 tabanlı ─────────────────────────────
let _fcmAccessToken: string | null = null;
let _fcmTokenExpiry = 0;
let _fcmRefreshPromise: Promise<string | null> | null = null;

async function getFcmAccessToken(): Promise<string | null> {
  if (_fcmAccessToken && Date.now() < _fcmTokenExpiry) return _fcmAccessToken;
  if (_fcmRefreshPromise) return _fcmRefreshPromise;

  _fcmRefreshPromise = (async (): Promise<string | null> => {
    let serviceAccount: { private_key?: string; client_email?: string } | null = null;
    if (process.env.FCM_SERVICE_ACCOUNT_JSON) {
      try { serviceAccount = JSON.parse(process.env.FCM_SERVICE_ACCOUNT_JSON); } catch {}
    } else if (process.env.FCM_SERVICE_ACCOUNT_PATH) {
      try {
        serviceAccount = JSON.parse(fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT_PATH, 'utf8'));
      } catch {}
    }

    if (!serviceAccount?.private_key || !serviceAccount?.client_email) {
      _fcmRefreshPromise = null;
      return null;
    }

    try {
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
        signal: AbortSignal.timeout(10_000),
      });

      if (!res.ok) {
        logger.warn({ detail: res.status }, '[FCM] OAuth2 token alınamadı:');
        return null;
      }

      const json = await res.json() as { access_token: string };
      _fcmAccessToken = json.access_token;
      _fcmTokenExpiry = Date.now() + 55 * 60 * 1000;
      return _fcmAccessToken;
    } catch (err) {
      logger.warn('[FCM] Token imzalama hatası:', (err as Error).message);
      return null;
    } finally {
      _fcmRefreshPromise = null;
    }
  })();

  return _fcmRefreshPromise;
}

export async function sendFCM(
  fcmToken: string,
  payload: PushPayload,
): Promise<void> {
  const projectId = process.env.FCM_PROJECT_ID;
  if (!projectId) return;

  const accessToken = await getFcmAccessToken();
  if (!accessToken) return;

  const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
  const badge = normalizePushBadge(payload.badge);

  const message = {
    token: fcmToken,
    notification: { title: payload.title, body: payload.body },
    data: Object.fromEntries(
      Object.entries(payload.data || {}).map(([k, v]) => [k, String(v)])
    ),
    android: {
      notification: {
        icon:               'ic_stat_bridge',
        color:              '#2d9cdb',
        notification_count: badge,
        channel_id:         'bridge_default',
      },
      priority: 'high',
    },
    apns: {
      payload: {
        aps: {
          badge,
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
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 404 || body.includes('UNREGISTERED')) {
        try {
          await Notifications.removeNativeTokenWhere({ token: fcmToken });
          await Notifications.removeFcmTokenWhere({ token: fcmToken });
        } catch (cleanupErr) {
          logger.warn({ err: (cleanupErr as Error).message, tokenPrefix: fcmToken.slice(0, 8), event: 'push.fcm.cleanup_failed' },
            "Geçersiz FCM tokenı DB'den kaldırılamadı.");
        }
      } else {
        logger.warn(`[FCM v1] Send error ${res.status}:`, body.slice(0, 200));
      }
    }
  } catch (err) {
    logger.warn('[FCM v1] Fetch error:', (err as Error).message);
  }
}

// ── APNs HTTP/2 — p8 key, direkt Apple sunucusuna ────────────
// FCM üzerinden değil — native APNs JWT tabanlı HTTP/2 entegrasyonu

interface ApnsConfig {
  keyPath:  string;
  keyId:    string;
  teamId:   string;
  bundleId: string;
  env:      'production' | 'sandbox';
}

function getApnsConfig(): ApnsConfig | null {
  const keyPath  = process.env.APNS_KEY_PATH;
  const keyId    = process.env.APNS_KEY_ID;
  const teamId   = process.env.APNS_TEAM_ID;
  const bundleId = process.env.APNS_BUNDLE_ID;
  if (!keyPath || !keyId || !teamId || !bundleId) return null;
  return {
    keyPath,
    keyId,
    teamId,
    bundleId,
    env: (process.env.APNS_ENV === 'production') ? 'production' : 'sandbox',
  };
}

// APNs JWT — 45 dakika geçerli, önceden üretilip cache'lenir
let _apnsJwt: string | null = null;
let _apnsJwtExpiry = 0;

function getApnsJwt(cfg: ApnsConfig): string {
  if (_apnsJwt && Date.now() < _apnsJwtExpiry) return _apnsJwt;

  const now    = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'ES256', kid: cfg.keyId })).toString('base64url');
  const claim  = Buffer.from(JSON.stringify({ iss: cfg.teamId, iat: now })).toString('base64url');

  const sigInput = `${header}.${claim}`;

  let privateKey: string;
  try {
    privateKey = fs.readFileSync(cfg.keyPath, 'utf8');
  } catch (err) {
    throw new Error(
  `[APNs] p8 key okunamadı (${cfg.keyPath}): ${(err as Error).message}`,
  { cause: err },
);
  }

  const sign     = crypto.createSign('SHA256');
  sign.update(sigInput);
  const signature = sign.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }, 'base64url');

  _apnsJwt       = `${sigInput}.${signature}`;
  _apnsJwtExpiry = Date.now() + 45 * 60 * 1000; // Apple 60dk kısıtı; 45dk'da yenile
  return _apnsJwt;
}

// HTTP/2 client havuzu — her host için tek bağlantı
const _http2Clients = new Map<string, http2.ClientHttp2Session>();

function getHttp2Client(host: string): http2.ClientHttp2Session {
  const existing = _http2Clients.get(host);
  if (existing && !existing.destroyed) return existing;

  const client = http2.connect(`https://${host}`);
  client.on('error', (err: Error) => {
    logger.warn(`[APNs] HTTP/2 bağlantı hatası (${host}):`, err.message);
    _http2Clients.delete(host);
  });
  client.on('close', () => _http2Clients.delete(host));
  _http2Clients.set(host, client);
  return client;
}

function apnsHttp2Request(
  client: http2.ClientHttp2Session,
  headers: http2.OutgoingHttpHeaders,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = client.request(headers);
    let responseBody = '';
    let statusCode = 0;

    req.on('response', (resHeaders: http2.IncomingHttpHeaders) => {
      const status = resHeaders[':status'];
      statusCode = typeof status === 'number' ? status : Number(Array.isArray(status) ? status[0] : status ?? 0);
      if (!Number.isInteger(statusCode) || statusCode < 0) statusCode = 0;
    });
    req.on('data', (chunk: Buffer) => { responseBody += chunk.toString(); });
    req.on('end', () => resolve({ status: statusCode, body: responseBody }));
    req.on('error', reject);

    req.setEncoding('utf8');
    req.write(body);
    req.end();
  });
}

export async function sendAPNs(
  deviceToken: string,
  payload: PushPayload,
): Promise<void> {
  const cfg = getApnsConfig();
  if (!cfg) return; // APNs yapılandırılmamış — sessizce geç

  const host = cfg.env === 'production'
    ? 'api.push.apple.com'
    : 'api.sandbox.push.apple.com';

  let jwt: string;
  try {
    jwt = getApnsJwt(cfg);
  } catch (err) {
    logger.warn('[APNs] JWT üretilemedi:', (err as Error).message);
    return;
  }

  const apsPayload = {
    aps: {
      alert: { title: payload.title, body: payload.body },
      badge: normalizePushBadge(payload.badge),
      sound: 'default',
      'content-available': 1,
    },
    ...(payload.data || {}),
  };

  const bodyStr = JSON.stringify(apsPayload);

  const headers: http2.OutgoingHttpHeaders = {
    ':method':           'POST',
    ':path':             `/3/device/${deviceToken}`,
    ':scheme':           'https',
    ':authority':        host,
    'authorization':     `bearer ${jwt}`,
    'apns-topic':        cfg.bundleId,
    'apns-push-type':    'alert',
    'apns-priority':     '10',
    'apns-expiration':   String(Math.floor(Date.now() / 1000) + 86400),
    'content-type':      'application/json',
    'content-length':    String(Buffer.byteLength(bodyStr)),
  };

  try {
    const client = getHttp2Client(host);
    const { status, body } = await apnsHttp2Request(client, headers, bodyStr);

    if (status === 200) return; // başarı

    let reason = '';
    try { reason = (JSON.parse(body) as { reason?: string }).reason ?? body; } catch { reason = body; }

    if (status === 410 || reason === 'Unregistered' || reason === 'BadDeviceToken') {
      // Token geçersiz — DB'den sil
      try {
        await Notifications.removeNativeTokenWhere({ token: deviceToken });
        logger.info(`[APNs] Geçersiz token kaldırıldı: ${deviceToken.slice(0, 8)}…`);
      } catch (cleanupErr) {
        logger.warn({ err: (cleanupErr as Error).message, tokenPrefix: deviceToken.slice(0, 8), event: 'push.apns.cleanup_failed' },
          "Geçersiz APNs tokenı DB'den kaldırılamadı.");
      }
    } else {
      logger.warn(`[APNs] Send error ${status}: ${reason}`);
    }
  } catch (err) {
    logger.warn('[APNs] HTTP/2 istek hatası:', (err as Error).message);
  }
}

/** APNs HTTP/2 bağlantılarını kapat (graceful shutdown için) */
export function closeApnsConnections(): void {
  for (const [host, client] of _http2Clients) {
    client.close();
    _http2Clients.delete(host);
    logger.info(`[APNs] HTTP/2 bağlantısı kapatıldı: ${host}`);
  }
}

// ── BADGE COUNT ───────────────────────────────────────────────
export async function getUnreadCount(userId: string): Promise<number> {
  try {
    let total = 0;

    const dmConvs = await Dms.findConversationsByUser(userId).catch(() => []) ?? [];
    if (dmConvs.length > 0) {
      const convIds = (dmConvs as Array<{ _id: string; lastRead?: Record<string, number> }>).map(c => c._id);
      const dmMsgs = await Dms.findMessagesWhere({
        dmId:   { $in: convIds },
        userId: { $ne: userId },
      }).catch(() => []) ?? [];

      for (const conv of (dmConvs as Array<{ _id: string; lastRead?: Record<string, number> }>)) {
        const lastRead = conv.lastRead?.[userId] || 0;
        total += (dmMsgs as Array<{ dmId: string; createdAt: number }>)
          .filter(m => m.dmId === conv._id && m.createdAt > lastRead).length;
      }
    }

    const memberships = await Members.findByUser(userId).catch(() => []) ?? [];
    if (memberships.length > 0) {
      const serverIds = (memberships as Array<{ serverId: string }>).map(m => m.serverId);
      const allChannels = await Channels.findWhere({
        serverId: { $in: serverIds },
        type:      'text',
      }).catch(() => []) ?? [];

      if (allChannels.length > 0) {
        const channelIds = (allChannels as Array<{ _id: string }>).map(c => c._id);
        // Preference-store failure must not be interpreted as "no mutes".
        // Let the outer safety boundary return badge=0 (fail closed).
        const prefs = await Notifications.prefsFind({
          userId,
          channelId: { $in: channelIds },
        }) ?? [];

        // Sessizlik karari TEK SAHIPTEN sorulur: elle `level === 'mute'`
        // yazmak `muteUntil` suresini yok sayar ve GECICI sessizligi KALICI
        // hale getirirdi (bkz. lib/notificationMute.ts).
        const mutedSet = new Set(
          (prefs as Array<{ level: string; channelId: string; muteUntil?: number | null }>)
            .filter(p => isMuted(p)).map(p => p.channelId)
        );

        const activeChannelIds = channelIds.filter(id => !mutedSet.has(id));
        if (activeChannelIds.length > 0) {
          const msgs = await Messages.messagesFind({
            channelId: { $in: activeChannelIds },
            userId:    { $ne: userId },
          }).catch(() => []) ?? [];

          for (const ch of (allChannels as Array<{ _id: string; lastRead?: Record<string, number> }>)) {
            if (mutedSet.has(ch._id)) continue;
            const lastRead = ch.lastRead?.[userId] || 0;
            total += (msgs as Array<{ channelId: string; createdAt: number }>)
              .filter(m => m.channelId === ch._id && m.createdAt > lastRead).length;
          }
        }
      }
    }

    return Math.min(total, 99);
  } catch {
    return 0;
  }
}

type PushDispatch = Pick<typeof import('./pushSender'), 'sendAPNs' | 'sendFCM'>;

function getPushDispatchForRuntime(): PushDispatch {
  const exported = module.exports as Partial<PushDispatch>;
  return {
    sendAPNs: exported.sendAPNs ?? sendAPNs,
    sendFCM:  exported.sendFCM  ?? sendFCM,
  };
}

// ── MAIN: SEND TO USER ────────────────────────────────────────
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<void> {
  try {
    const dispatch = getPushDispatchForRuntime();
    const badge = await getUnreadCount(userId);

    const isE2E = typeof payload.body === 'string' && payload.body.startsWith('🔒e2e:');
    const enrichedPayload: PushPayload = {
      ...payload,
      badge,
      ...(isE2E ? { body: '🔒 Şifreli mesaj' } : {}),
    };

    // Delivery is best-effort per transport, but repository failures stay
    // observable. A broken web-push table must not suppress native delivery,
    // and vice versa. API/configuration routes still receive repository
    // failures directly and return 503 instead of claiming success.
    let webSubs: WebPushSubscription[] = [];
    try {
      webSubs = normalizeWebPushRows(await Notifications.findPushSubscriptionsForUser(userId));
    } catch (err) {
      logger.warn({ err, userId, event: 'push.targets.webpush_read_failed' }, 'Web-push targets could not be read');
    }
    await Promise.allSettled(webSubs.map(sub =>
      sendWebPush({ endpoint: sub.endpoint, keys: sub.keys }, enrichedPayload)
    ));

    let nativeTokens: Array<NativeTokenRow & { platform?: string }> = [];
    try {
      nativeTokens = normalizeNativeTokenRows(await Notifications.findNativeTokensForUser(userId));
    } catch (err) {
      logger.warn({ err, userId, event: 'push.targets.native_read_failed' }, 'Native push targets could not be read');
    }

    // Platform bazlı yönlendirme:
    // iOS → APNs HTTP/2 (doğrudan), Android → FCM v1
    const apnsEnabled = !!getApnsConfig();

    await Promise.allSettled(nativeTokens.map(r => {
      if (r.platform === 'ios' && apnsEnabled) {
        return dispatch.sendAPNs(r.token, enrichedPayload);
      }
      return dispatch.sendFCM(r.token, enrichedPayload);
    }));

    // Legacy FCM token'ları (platform bilgisi olmayan eski kayıtlar)
    let legacyTokens: NativeTokenRow[] = [];
    try {
      legacyTokens = normalizeNativeTokenRows(await Notifications.findFcmTokensForUser(userId));
    } catch (err) {
      logger.warn({ err, userId, event: 'push.targets.fcm_read_failed' }, 'Legacy FCM targets could not be read');
    }
    await Promise.allSettled(legacyTokens.map(r => dispatch.sendFCM(r.token, enrichedPayload)));
  } catch (err) {
    logger.warn('[pushSender] sendPushToUser error:', (err as Error).message);
  }
}

export async function clearBadge(userId: string): Promise<void> {
  try {
    const nativeTokens = normalizeNativeTokenRows(await Notifications.findNativeTokensForUser(userId));
    const apnsEnabled  = !!getApnsConfig();

    // APNs badge clear
    if (apnsEnabled) {
      const iosTokens = nativeTokens.filter(r => r.platform === 'ios');
      if (iosTokens.length > 0) {
        const cfg  = getApnsConfig()!;
        const host = cfg.env === 'production' ? 'api.push.apple.com' : 'api.sandbox.push.apple.com';
        let jwt: string;
        try { jwt = getApnsJwt(cfg); } catch { jwt = ''; }

        if (jwt) {
          await Promise.allSettled(iosTokens.map(async r => {
            const body = JSON.stringify({ aps: { badge: 0, 'content-available': 1 } });
            const headers: http2.OutgoingHttpHeaders = {
              ':method':        'POST',
              ':path':          `/3/device/${r.token}`,
              ':scheme':        'https',
              ':authority':     host,
              'authorization':  `bearer ${jwt}`,
              'apns-topic':     cfg.bundleId,
              'apns-push-type': 'background',
              'apns-priority':  '5',
              'content-type':   'application/json',
              'content-length': String(Buffer.byteLength(body)),
            };
            try {
              const client = getHttp2Client(host);
              await apnsHttp2Request(client, headers, body);
            } catch (err) {
              logger.warn('[APNs] clearBadge hata:', (err as Error).message);
            }
          }));
        }
      }
    }

    // FCM badge clear (Android + APNs yapılandırılmamış iOS)
    const projectId = process.env.FCM_PROJECT_ID;
    if (projectId) {
      const accessToken = await getFcmAccessToken();
      if (accessToken) {
        const url = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
        const fcmTokens = apnsEnabled
          ? nativeTokens.filter(r => r.platform !== 'ios')
          : nativeTokens;

        await Promise.allSettled(fcmTokens.map(async r => {
          const message = {
            token: r.token,
            data: { badge: '0', type: 'badge_clear' },
            android: { priority: 'normal' },
            apns: {
              payload: { aps: { badge: 0, 'content-available': 1 } },
              headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
            },
          };
          try {
            const res = await fetch(url, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ message }),
              signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) {
              const body = await res.text();
              if (res.status === 404 || body.includes('UNREGISTERED')) {
                try {
                  await Notifications.removeNativeTokenWhere({ token: r.token });
                } catch (cleanupErr) {
                  logger.warn({ err: (cleanupErr as Error).message, tokenPrefix: r.token.slice(0, 8), event: 'push.clear_badge.cleanup_failed' },
                    "Geçersiz push tokenı badge temizleme sırasında DB'den kaldırılamadı.");
                }
              }
            }
          } catch (err) {
            logger.warn('[pushSender] clearBadge FCM send error:', (err as Error).message);
          }
        }));
      }
    }
  } catch (err) {
    logger.warn('[pushSender] clearBadge error:', (err as Error).message);
  }
}


