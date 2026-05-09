// @ts-nocheck
// server/middleware/rateLimit.ts
// Sliding-window rate limiter
// Redis-backed store (falls back to in-memory when Redis unavailable)
// Tekrarlı ihlallerde otomatik geçici IP ban entegrasyonu

import { Request, Response, NextFunction } from 'express';
import logger from '../lib/logger';

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
  bots:           { max: parseInt(process.env.RL_BOTS_MAX      || '') || 20,  windowMs: parseInt(process.env.RL_BOTS_WIN      || '') || 60_000  },
  write:          { max: parseInt(process.env.RL_WRITE_MAX     || '') || 30,  windowMs: parseInt(process.env.RL_WRITE_WIN     || '') || 60_000  },
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

let _redis: RedisClient | null = null;
let _redisReady = false;

async function getRedis(): Promise<RedisClient | null> {
  if (_redis) return _redis;
  try {
     
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { createClient } = require('redis') as { createClient(opts: Record<string, unknown>): RedisClient };
    const url = process.env.REDIS_URL || 'redis://localhost:6379';
    const client = createClient({ url, socket: { connectTimeout: 3000, reconnectStrategy: (retries: number) => {
      if (retries > 10) return new Error('Redis rate-limit: 10 bağlantı denemesi başarısız');
      return Math.min(retries * 300, 3000); // üstel backoff, max 3s
    } } });
    client.on('error', () => { _redisReady = false; });
    client.on('ready', () => { _redisReady = true; });
    await client.connect();
    _redis = client;
    _redisReady = true;
    logger.info({ event: 'ratelimit.redis.enabled' }, 'Rate-limit Redis store enabled.');
    return _redis;
  } catch {
    logger.warn({ event: 'ratelimit.redis.unavailable' }, 'Redis unavailable for rate limit; using in-memory fallback.');
    return null;
  }
}

const memStore = new Map<string, number[]>();
const MAX_STORE_SIZE = 100_000;

async function hitRedis(key: string, windowMs: number): Promise<number | null> {
  const client = await getRedis();
  if (!client || !_redisReady) return null;
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
    _redisReady = false;
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
}, 10 * 60_000);

const VIOLATION_KEY_TTL = 3600;

export async function getViolationRecord(ip: string): Promise<ViolationRecord | null> {
  const client = await getRedis();
  if (client && _redisReady) {
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
  if (client && _redisReady) {
    try {
      await client.set(`rl:violations:${ip}`, JSON.stringify(rec), { EX: VIOLATION_KEY_TTL });
      return;
    } catch { /* fallback */ }
  }
  _httpViolationsMem.set(ip, rec);
}

export async function deleteViolationRecord(ip: string): Promise<void> {
  const client = await getRedis();
  if (client && _redisReady) {
    try { await client.del(`rl:violations:${ip}`); } catch { /* fallback */ }
  }
  _httpViolationsMem.delete(ip);
}

interface RateLimitOptions {
  userOnly?: boolean;
}

export function rateLimit(
  max: number,
  windowMs: number,
  keyPrefix = '',
  opts: RateLimitOptions = {}
) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ip = getClientIp(req);
    const uid = (req as Request & { user?: { id: string } }).user?.id || '';
    const key = opts.userOnly && uid
      ? `rl:${keyPrefix}:u:${uid}`
      : `rl:${keyPrefix}:${ip}:${uid}`;

    let count = await hitRedis(key, windowMs);
    if (count === null) count = hitMemory(key, windowMs);

    const remaining = Math.max(0, max - count);
    const resetAt   = Math.ceil((Date.now() + windowMs) / 1000);

    res.set('X-RateLimit-Limit',     String(max));
    res.set('X-RateLimit-Remaining', String(remaining));
    res.set('X-RateLimit-Reset',     String(resetAt));

    if (count > max) {
      const retryAfter = Math.ceil(windowMs / 1000);
      res.set('Retry-After', String(retryAfter));

      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { trackRateLimitHit, _bumpAnomalyCounter } = require('./metrics') as {
          trackRateLimitHit: (req: Request, category: string) => void;
          _bumpAnomalyCounter: () => void;
        };
        trackRateLimitHit(req, keyPrefix);
        _bumpAnomalyCounter();
      } catch { /* metrics modülü yüklenmemişse atla */ }

      try {
        const rec: ViolationRecord = (await getViolationRecord(ip)) || { count: 0, firstAt: Date.now() };
        rec.count += 1;
        if (rec.count === 1) rec.firstAt = Date.now();
        await setViolationRecord(ip, rec);

        if (rec.count >= HTTP_AUTO_BAN_THRESHOLD) {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { getBan: getIpBan, banIp } = require('./ipBan') as {
            getBan: (ip: string) => Promise<unknown>;
            banIp:  (ip: string, opts: Record<string, unknown>) => Promise<void>;
          };
          const existing = await getIpBan(ip);
          if (!existing) {
            await banIp(ip, {
              reason:     `Otomatik ban: HTTP rate limit (${keyPrefix}) ${rec.count}x aşıldı`,
              durationMs: HTTP_AUTO_BAN_DURATION_MS,
              adminId:    'system',
            });
            try {
              // eslint-disable-next-line @typescript-eslint/no-var-requires
              const { trackAutoBan } = require('./metrics') as { trackAutoBan: (c: string) => void };
              trackAutoBan(keyPrefix);
            } catch { /* ignore */ }
            logger.warn(
              { ip, prefix: keyPrefix, durationMinutes: HTTP_AUTO_BAN_DURATION_MS / 60_000, event: 'ratelimit.auto_ban.applied' },
              'Automatic HTTP IP ban applied due to repeated rate-limit violations.'
            );
            await deleteViolationRecord(ip);
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

setInterval(pruneMemStore, 5 * 60_000);

// ── Kısa yardımcılar ─────────────────────────────────────────
const _u = (key: string) => () => rateLimit(DEFAULTS[key].max, DEFAULTS[key].windowMs, key, { userOnly: true });
const _i = (key: string) => () => rateLimit(DEFAULTS[key].max, DEFAULTS[key].windowMs, key);

export const limits = {
  register:       _i('register'),
  login:          _i('login'),
  refresh:        _i('refresh'),
  changePassword: _u('changePassword'),
  twoFactor:      _i('twoFactor'),
  email:          _i('email'),
  upload:         _u('upload'),
  messages:       _u('messages'),
  react:          _u('react'),
  settings:       _u('settings'),
  dm:             _u('dm'),
  friends:        _u('friends'),
  servers:        _u('servers'),
  roles:          _u('roles'),
  channels:       _u('channels'),
  polls:          _u('polls'),
  webhooks:       _u('webhooks'),
  moderation:     _u('moderation'),
  bots:           _u('bots'),
  write:          _u('write'),
  search:         _u('search'),
  ai:             _u('ai'),
  invite:         _i('invite'),
  federation:     _i('federation'),
  global:         _i('global'),
};
