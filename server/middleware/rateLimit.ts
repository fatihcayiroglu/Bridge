// server/middleware/rateLimit.ts
// Sliding-window rate limiter
// Redis-backed store (falls back to in-memory when Redis unavailable)
// Tekrarlı ihlallerde otomatik geçici IP ban entegrasyonu
//
// Granülerlik stratejisi:
//   • IP-only   → kimlik doğrulanmamış endpoint'ler (login, register)
//   • User-only → kullanıcıya özel kotalar (upload, messages, ai)
//   • IP+User   → ikili limit; biri aşılınca 429 (çoğu endpoint)
//   • Global    → tüm istekler için arka plan güvenlik ağı
//
// Sprint 41 NOT: IP+User dual-key implementasyonu TAMAMLANDI.
//   Roadmap'teki 'rate limit dual-key eksik' maddesi kapatıldı.
//   Ayrıca: ihlal sayısı eşiği aşılınca otomatik IP ban aktif (bkz. ipBan.ts).
//   Bu davranış DEPLOYMENT_GUIDE.md'ye dokümante edilmeli.

import { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger';
import { tryRequire } from '../lib/_optional-require';

// ── Opsiyonel modüller (metrics + ipBan) ──────────────────────
// Bu modüller her deploy'da bulunmayabilir; tryRequire null döndürür, middleware çalışmaya devam eder.
interface MetricsModule {
  trackRateLimitHit: (req: Request, category: string) => void;
  _bumpAnomalyCounter: () => void;
  trackAutoBan: (category: string) => void;
}
interface IpBanModule {
  getBan: (ip: string) => Promise<unknown>;
  banIp:  (ip: string, opts: Record<string, unknown>) => Promise<void>;
}
const _metrics = tryRequire<MetricsModule>('./metrics');
const _ipBan   = tryRequire<IpBanModule>('./ipBan');

const TRUSTED_PROXY_COUNT = parseInt(process.env.TRUSTED_PROXY_COUNT ?? '1', 10);

function getClientIp(req: Request): string {
  const reqIp = (req as Request & { ip?: string }).ip;
  if (reqIp && reqIp !== '::1' && reqIp !== '127.0.0.1') return reqIp;
  const xff = req.headers['x-forwarded-for'] as string | undefined;
  if (!xff || TRUSTED_PROXY_COUNT === 0) {
    return ((req.socket?.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
  }
  const hops = xff.split(',').map(s => s.trim()).filter(Boolean);
  const clientIdx = hops.length - TRUSTED_PROXY_COUNT;
  const ip = clientIdx >= 0 ? hops[clientIdx] : hops[0];
  return ip.replace(/^::ffff:/, '');
}

interface LimitConfig {
  max:      number;
  windowMs: number;
}

const DEFAULTS: Record<string, LimitConfig> = {
  register:       { max: parseInt(process.env.RL_REGISTER_MAX  || '') || 5,   windowMs: parseInt(process.env.RL_REGISTER_WIN  || '') || 60_000  },
  login:          { max: parseInt(process.env.RL_LOGIN_MAX     || '') || 10,  windowMs: parseInt(process.env.RL_LOGIN_WIN     || '') || 60_000  },
  refresh:        { max: parseInt(process.env.RL_REFRESH_MAX   || '') || 30,  windowMs: parseInt(process.env.RL_REFRESH_WIN   || '') || 60_000  },
  changePassword: { max: parseInt(process.env.RL_CHGPWD_MAX   || '') || 3,   windowMs: parseInt(process.env.RL_CHGPWD_WIN   || '') || 300_000 },
  upload:         { max: parseInt(process.env.RL_UPLOAD_MAX    || '') || 20,  windowMs: parseInt(process.env.RL_UPLOAD_WIN    || '') || 60_000  },
  messages:       { max: parseInt(process.env.RL_MESSAGES_MAX  || '') || 30,  windowMs: parseInt(process.env.RL_MESSAGES_WIN  || '') || 60_000  },
  react:          { max: parseInt(process.env.RL_REACT_MAX     || '') || 60,  windowMs: parseInt(process.env.RL_REACT_WIN     || '') || 60_000  },
  settings:       { max: parseInt(process.env.RL_SETTINGS_MAX  || '') || 10,  windowMs: parseInt(process.env.RL_SETTINGS_WIN  || '') || 60_000  },
  search:         { max: parseInt(process.env.RL_SEARCH_MAX    || '') || 20,  windowMs: parseInt(process.env.RL_SEARCH_WIN    || '') || 60_000  },
  ai:             { max: parseInt(process.env.RL_AI_MAX        || '') || 10,  windowMs: parseInt(process.env.RL_AI_WIN        || '') || 60_000  },
  'ai.stream':    { max: parseInt(process.env.RL_AI_STREAM_MAX  || '') || 5,   windowMs: parseInt(process.env.RL_AI_STREAM_WIN  || '') || 60_000  },
  invite:         { max: parseInt(process.env.RL_INVITE_MAX    || '') || 10,  windowMs: parseInt(process.env.RL_INVITE_WIN    || '') || 60_000  },
  twoFactor:      { max: parseInt(process.env.RL_2FA_MAX       || '') || 5,   windowMs: parseInt(process.env.RL_2FA_WIN       || '') || 300_000 },
  dm:             { max: parseInt(process.env.RL_DM_MAX        || '') || 20,  windowMs: parseInt(process.env.RL_DM_WIN        || '') || 60_000  },
  global:         { max: parseInt(process.env.RL_GLOBAL_MAX    || '') || 300, windowMs: parseInt(process.env.RL_GLOBAL_WIN    || '') || 60_000  },
  friends:        { max: parseInt(process.env.RL_FRIENDS_MAX   || '') || 20,  windowMs: parseInt(process.env.RL_FRIENDS_WIN   || '') || 60_000  },
  servers:        { max: parseInt(process.env.RL_SERVERS_MAX   || '') || 10,  windowMs: parseInt(process.env.RL_SERVERS_WIN   || '') || 60_000  },
  roles:          { max: parseInt(process.env.RL_ROLES_MAX     || '') || 20,  windowMs: parseInt(process.env.RL_ROLES_WIN     || '') || 60_000  },
  channels:       { max: parseInt(process.env.RL_CHANNELS_MAX  || '') || 20,  windowMs: parseInt(process.env.RL_CHANNELS_WIN  || '') || 60_000  },
  polls:          { max: parseInt(process.env.RL_POLLS_MAX     || '') || 10,  windowMs: parseInt(process.env.RL_POLLS_WIN     || '') || 60_000  },
  webhooks:       { max: parseInt(process.env.RL_WEBHOOKS_MAX  || '') || 15,  windowMs: parseInt(process.env.RL_WEBHOOKS_WIN  || '') || 60_000  },
  federation:     { max: parseInt(process.env.RL_FEDERATION_MAX|| '') || 30,  windowMs: parseInt(process.env.RL_FEDERATION_WIN|| '') || 60_000  },
  moderation:     { max: parseInt(process.env.RL_MODERATION_MAX|| '') || 30,  windowMs: parseInt(process.env.RL_MODERATION_WIN|| '') || 60_000  },
  email:          { max: parseInt(process.env.RL_EMAIL_MAX     || '') || 5,   windowMs: parseInt(process.env.RL_EMAIL_WIN     || '') || 300_000 },
  bots:           { max: parseInt(process.env.RL_BOTS_MAX        || '') || 20,  windowMs: parseInt(process.env.RL_BOTS_WIN        || '') || 60_000  },
  write:          { max: parseInt(process.env.RL_WRITE_MAX       || '') || 30,  windowMs: parseInt(process.env.RL_WRITE_WIN       || '') || 60_000  },
  // Sprint 108: voice-state endpoint — mute/deaf güncellemeleri burst'e açık; kısıtlı tutulur
  voiceState:     { max: parseInt(process.env.RL_VOICE_STATE_MAX || '') || 30,  windowMs: parseInt(process.env.RL_VOICE_STATE_WIN || '') || 10_000   },
  // Sprint 121 FIX 25: serverEvents.ts'de limits.api kullanılıyor — eksik tanım eklendi
  api:            { max: parseInt(process.env.RL_API_MAX         || '') || 60,  windowMs: parseInt(process.env.RL_API_WIN         || '') || 60_000  },
  serverEvents:   { max: parseInt(process.env.RL_SERVER_EVENTS_MAX || '') || 20, windowMs: parseInt(process.env.RL_SERVER_EVENTS_WIN || '') || 60_000 },
};

// ── STORE: Redis-backed with in-memory fallback ──────────────

interface RedisClient {
  multi(): {
    zAdd(key: string, members: { score: number; value: string }[]): unknown;
    zRemRangeByScore(key: string, min: string, max: number): unknown;
    zCard(key: string): unknown;
    expire(key: string, seconds: number): unknown;
    exec(): Promise<unknown[]>;
  };
  set(key: string, value: string, opts?: { EX?: number }): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  on(event: string, cb: () => void): void;
  connect(): Promise<void>;
}

// Sprint 121 FIX 24: Bağımsız Redis client yerine redisAdapter paylaşımlı client kullanılıyor
import { redisClient as _sharedRedisClient, isRedisAvailable } from '../lib/redisAdapter';

async function getRedis(): Promise<RedisClient | null> {
  if (!isRedisAvailable()) return null;
  return _sharedRedisClient() as RedisClient | null;
}

const memStore = new Map<string, number[]>();
const MAX_STORE_SIZE = 100_000;

async function hitRedis(key: string, windowMs: number): Promise<number | null> {
  const client = await getRedis();
  if (!client) return null;
  try {
    const now = Date.now();
    const windowSec = Math.ceil(windowMs / 1000);
    const member = `${now}:${Math.random()}`;
    const pipe = client.multi();
    pipe.zAdd(key, [{ score: now, value: member }]);
    pipe.zRemRangeByScore(key, '-inf', now - windowMs);
    pipe.zCard(key);
    pipe.expire(key, windowSec + 1);
    const results = await pipe.exec();
    return results[2] as number;
  } catch {
    
    logger.warn({ event: 'ratelimit.redis.error' }, 'Redis rate-limit operation failed; switching to in-memory fallback.');
    return null;
  }
}

function hitMemory(key: string, windowMs: number): number {
  if (memStore.size > MAX_STORE_SIZE) pruneMemStore();
  const now = Date.now();
  const hits = (memStore.get(key) || []).filter(t => now - t < windowMs);
  hits.push(now);
  memStore.set(key, hits);
  return hits.length;
}

const HTTP_AUTO_BAN_THRESHOLD   = parseInt(process.env.RL_HTTP_AUTO_BAN_THRESHOLD || '') || 10;
const HTTP_AUTO_BAN_DURATION_MS = parseInt(process.env.RL_HTTP_AUTO_BAN_DURATION  || '') || 10 * 60_000;

interface ViolationRecord {
  count: number;
  firstAt: number;
}

const _httpViolationsMem = new Map<string, ViolationRecord>();
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of _httpViolationsMem) {
    if (now - rec.firstAt > 3_600_000) _httpViolationsMem.delete(ip);
  }
}, 10 * 60_000).unref();

const VIOLATION_KEY_TTL = 3600;

export async function getViolationRecord(ip: string): Promise<ViolationRecord | null> {
  const client = await getRedis();
  if (client) {
    try {
      const raw = await client.get(`rl:violations:${ip}`);
      if (!raw) return null;
      return JSON.parse(raw) as ViolationRecord;
    } catch { /* fallback */ }
  }
  return _httpViolationsMem.get(ip) || null;
}

export async function setViolationRecord(ip: string, rec: ViolationRecord): Promise<void> {
  const client = await getRedis();
  if (client) {
    try {
      await client.set(`rl:violations:${ip}`, JSON.stringify(rec), { EX: VIOLATION_KEY_TTL });
      return;
    } catch { /* fallback */ }
  }
  _httpViolationsMem.set(ip, rec);
}

export async function deleteViolationRecord(ip: string): Promise<void> {
  const client = await getRedis();
  if (client) {
    try { await client.del(`rl:violations:${ip}`); } catch { /* fallback */ }
  }
  _httpViolationsMem.delete(ip);
}

// ── Granülerlik modu ─────────────────────────────────────────────
// 'ip'          → Yalnızca IP bazlı (kimlik doğrulanmamış: login, register)
// 'user'        → Yalnızca user-ID bazlı (oturum açık: upload, ai)
// 'combined'    → IP+user: her ikisi de kontrol edilir, biri aşılınca 429 (varsayılan)
// 'ip-only'     → Authenticated bile olsa sadece IP (federation ping vb.)
// 'per-user-ip' → user+IP kombinasyonu: VPN dönüşümü + çok hesap saldırısına karşı
//                 Aynı kullanıcının farklı IP'lerden spam yapmasını da engeller
type RateLimitMode = 'ip' | 'user' | 'combined' | 'ip-only' | 'per-user-ip';

interface RateLimitOptions {
  /** @deprecated 'mode' kullanın — geriye dönük uyumluluk için korunuyor */
  userOnly?: boolean;
  /** Granülerlik modu. Varsayılan: userOnly=true → 'user', userOnly=false → 'combined' */
  mode?: RateLimitMode;
}

export function rateLimit(
  max: number,
  windowMs: number,
  keyPrefix = '',
  opts: RateLimitOptions = {}
) {
  // Geriye dönük uyumluluk: userOnly → mode dönüşümü
  const mode: RateLimitMode = opts.mode ?? (opts.userOnly ? 'user' : 'combined');

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip  = getClientIp(req);
    const uid = (req as Request & { user?: { id: string } }).user?.id || '';

    // ── Anahtar(lar) oluştur ─────────────────────────────────
    let keys: string[];
    switch (mode) {
      case 'ip':
        keys = [`rl:${keyPrefix}:ip:${ip}`];
        break;
      case 'user':
        keys = uid ? [`rl:${keyPrefix}:u:${uid}`] : [`rl:${keyPrefix}:ip:${ip}`];
        break;
      case 'ip-only':
        keys = [`rl:${keyPrefix}:ip:${ip}`];
        break;
      case 'per-user-ip':
        // user+IP birleşik anahtar: hem kullanıcı kotasını hem IP başına kotayı takip eder
        // VPN dönüşüm saldırılarına ve çok hesaplı kötüye kullanıma karşı etkili
        keys = uid
          ? [
              `rl:${keyPrefix}:u:${uid}`,          // kullanıcı kotası
              `rl:${keyPrefix}:uip:${uid}:${ip}`,   // kullanıcı+IP kombinasyon kotası
            ]
          : [`rl:${keyPrefix}:ip:${ip}`];
        break;
      case 'combined':
      default:
        // Her ikisini de izle — en yüksek sayım kullanılır
        keys = uid
          ? [`rl:${keyPrefix}:ip:${ip}`, `rl:${keyPrefix}:u:${uid}`]
          : [`rl:${keyPrefix}:ip:${ip}`];
    }

    // ── Sayımları paralel al ─────────────────────────────────
    const counts = await Promise.all(keys.map(async key => {
      let c = await hitRedis(key, windowMs);
      if (c === null) c = hitMemory(key, windowMs);
      return c;
    }));
    const count = Math.max(...counts);

    const remaining = Math.max(0, max - count);
    const resetAt   = Math.ceil((Date.now() + windowMs) / 1000);

    res.set('X-RateLimit-Limit',     String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset',     String(resetAt));
    // RFC 6585 policy header — client'a mod bilgisi ver
    res.set('X-RateLimit-Policy',    `${max};w=${Math.ceil(windowMs / 1000)};mode=${mode};keys=${keys.length}`);

    if (count > max) {
      const retryAfter = Math.ceil(windowMs / 1000);
      res.set('Retry-After', String(retryAfter));

      // _metrics top-level'da yüklendi; yoksa null
      if (_metrics) {
        try {
          _metrics.trackRateLimitHit(req, keyPrefix);
          _metrics._bumpAnomalyCounter();
        } catch { /* non-fatal */ }
      }

      try {
        const rec: ViolationRecord = (await getViolationRecord(ip)) || { count: 0, firstAt: Date.now() };
        rec.count += 1;
        if (rec.count === 1) rec.firstAt = Date.now();
        await setViolationRecord(ip, rec);

        if (rec.count >= HTTP_AUTO_BAN_THRESHOLD) {
          if (_ipBan) {
            const existing = await _ipBan.getBan(ip);
            if (!existing) {
              await _ipBan.banIp(ip, {
                reason:     `Otomatik ban: HTTP rate limit (${keyPrefix}) ${rec.count}x aşıldı`,
                durationMs: HTTP_AUTO_BAN_DURATION_MS,
                adminId:    'system',
              });
              if (_metrics) { try { _metrics.trackAutoBan(keyPrefix); } catch { /* ignore */ } }
              logger.warn(
                { ip, prefix: keyPrefix, durationMinutes: HTTP_AUTO_BAN_DURATION_MS / 60_000, event: 'ratelimit.auto_ban.applied' },
                'Automatic HTTP IP ban applied due to repeated rate-limit violations.'
              );
              await deleteViolationRecord(ip);
            }
          }
        }
      } catch (banErr) {
        logger.error({ err: banErr, event: 'ratelimit.auto_ban.failed' }, 'Failed to apply automatic IP ban.');
      }

      res.status(429).json({
        error: `Too many requests. Retry in ${retryAfter} seconds.`,
        retryAfter,
      });
      return;
    }
    next();
  };
}

const maxWindow = Math.max(...Object.values(DEFAULTS).map(d => d.windowMs));

export function pruneMemStore(): void {
  const cutoff = Date.now() - maxWindow;
  for (const [key, hits] of memStore) {
    const fresh = hits.filter(t => t > cutoff);
    if (!fresh.length) memStore.delete(key); else memStore.set(key, fresh);
  }
}

setInterval(pruneMemStore, 5 * 60_000).unref();

// ── Kısa yardımcılar ─────────────────────────────────────────
// _ip  → yalnızca IP (kimlik doğrulanmamış endpointler: login, register, 2FA)
// _u   → yalnızca user-ID (oturum açık, kişisel kota: upload, ai, messages)
// _c   → combined IP+user (genel authenticated endpointler)
// _uip → per-user-IP: user+IP kombinasyonu (VPN dönüşüm + çok hesap saldırılarına karşı)
const _ip  = (key: string) => () => rateLimit(DEFAULTS[key].max, DEFAULTS[key].windowMs, key, { mode: 'ip' });
const _u   = (key: string) => () => rateLimit(DEFAULTS[key].max, DEFAULTS[key].windowMs, key, { mode: 'user' });
const _c   = (key: string) => () => rateLimit(DEFAULTS[key].max, DEFAULTS[key].windowMs, key, { mode: 'combined' });
const _uip = (key: string) => () => rateLimit(DEFAULTS[key].max, DEFAULTS[key].windowMs, key, { mode: 'per-user-ip' });

export const limits = {
  // IP-only: henüz kimlik doğrulanmamış — user-ID yok
  register:       _ip('register'),
  login:          _ip('login'),
  twoFactor:      _ip('twoFactor'),
  email:          _ip('email'),
  invite:         _ip('invite'),

  // User-only: kişisel kota, VPN arkasındaki kullanıcılar sorunsuz erişsin
  upload:         _u('upload'),
  messages:       _u('messages'),
  react:          _u('react'),
  settings:       _u('settings'),
  dm:             _u('dm'),
  ai:             _uip('ai'),
  'ai.stream':    _uip('ai.stream'),
  write:          _u('write'),
  search:         _c('search'),

  // Combined: hem IP hem user-ID izlenir — ikisi de aşılınca 429
  refresh:        _c('refresh'),
  changePassword: _c('changePassword'),
  friends:        _c('friends'),
  servers:        _c('servers'),
  roles:          _c('roles'),
  channels:       _c('channels'),
  polls:          _c('polls'),
  webhooks:       _c('webhooks'),
  moderation:     _uip('moderation'),  // per-user-IP: moderasyon işlemlerinde VPN atlatma engeli
  bots:           _c('bots'),
  federation:     _c('federation'),
  global:         _c('global'),
  general:        _c('global'),
  // Sprint 108: voice-state per-user — kullanıcı başına izlenir (IP değil)
  voiceState:     _u('voiceState'),
  // Sprint 121 FIX 25: serverEvents.ts / genel API endpoint'leri için
  api:            _c('api'),
  serverEvents:   _c('serverEvents'),
};
