// server/middleware/ipBan.ts
// IP bazlı erişim engeli
// Redis varsa Redis'te tutar (tüm instance'lar senkron),
// yoksa in-memory Map'e düşer (tek node yeterli).

import { Request, Response, NextFunction } from 'express';

const TRUSTED_PROXY_COUNT = parseInt(process.env.TRUSTED_PROXY_COUNT ?? '1', 10);

// ── IP çözümleyici ───────────────────────────────────────────
export function getClientIp(req: Request): string {
  const reqIp = (req as Request & { ip?: string }).ip;
  if (reqIp && reqIp !== '::1' && reqIp !== '127.0.0.1') return reqIp;
  const xff = req.headers['x-forwarded-for'] as string | undefined;
  if (!xff || TRUSTED_PROXY_COUNT === 0) {
    return ((req.socket?.remoteAddress) || 'unknown').replace(/^::ffff:/, '');
  }
  const hops = xff.split(',').map(s => s.trim()).filter(Boolean);
  const idx = hops.length - TRUSTED_PROXY_COUNT;
  return (idx >= 0 ? hops[idx] : hops[0]).replace(/^::ffff:/, '');
}

// ── Types ────────────────────────────────────────────────────
export interface BanEntry {
  ip: string;
  reason: string;
  bannedAt: number;
  expiresAt: number | null;
  adminId: string | null;
}

export interface BanOptions {
  reason?: string;
  durationMs?: number | null;
  adminId?: string | null;
}

// ── In-memory fallback ──────────────────────────────────────
const _memBans = new Map<string, BanEntry>();

// ── Redis bağlantısı (opsiyonel) ────────────────────────────
interface RedisLike {
  status: string;
  set(key: string, value: string): Promise<unknown>;
  expire(key: string, seconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

let _redis: RedisLike | null = null;
const REDIS_KEY_PREFIX = 'bridge:ipban:';

function _tryGetRedis(): RedisLike | null {
  if (_redis) return _redis;
  try {
    const g = global as unknown as { _bridgeRedis?: RedisLike };
    if (g._bridgeRedis?.status === 'ready') {
      _redis = g._bridgeRedis;
    }
  } catch { /* redis yok, sorun değil */ }
  return _redis;
}

// ── Temel CRUD ──────────────────────────────────────────────

export async function banIp(
  ip: string,
  { reason = 'Admin ban', durationMs = null, adminId = null }: BanOptions = {}
): Promise<BanEntry> {
  if (!ip || ip === 'unknown') throw new Error('Geçersiz IP');

  const bannedAt = Date.now();
  const expiresAt = durationMs ? bannedAt + durationMs : null;
  const entry: BanEntry = { ip, reason, bannedAt, expiresAt, adminId };

  const redis = _tryGetRedis();
  if (redis) {
    const ttlSeconds = durationMs ? Math.ceil(durationMs / 1000) : 0;
    const cmd = redis.set(`${REDIS_KEY_PREFIX}${ip}`, JSON.stringify(entry));
    if (ttlSeconds > 0) await redis.expire(`${REDIS_KEY_PREFIX}${ip}`, ttlSeconds);
    await cmd;
  } else {
    _memBans.set(ip, entry);
  }
  return entry;
}

export async function unbanIp(ip: string): Promise<void> {
  const redis = _tryGetRedis();
  if (redis) {
    await redis.del(`${REDIS_KEY_PREFIX}${ip}`);
  } else {
    _memBans.delete(ip);
  }
}

export async function getBan(ip: string): Promise<BanEntry | null> {
  const redis = _tryGetRedis();
  if (redis) {
    const raw = await redis.get(`${REDIS_KEY_PREFIX}${ip}`);
    if (!raw) return null;
    const entry = JSON.parse(raw) as BanEntry;
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      await redis.del(`${REDIS_KEY_PREFIX}${ip}`);
      return null;
    }
    return entry;
  }

  const entry = _memBans.get(ip);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    _memBans.delete(ip);
    return null;
  }
  return entry;
}

export async function listBans(): Promise<BanEntry[]> {
  const redis = _tryGetRedis();
  if (redis) {
    const keys = await redis.keys(`${REDIS_KEY_PREFIX}*`);
    if (!keys.length) return [];
    const values = await redis.mget(...keys);
    const now = Date.now();
    return values
      .filter(Boolean)
      .map(v => JSON.parse(v as string) as BanEntry)
      .filter(e => !e.expiresAt || e.expiresAt > now);
  }

  const now = Date.now();
  const result: BanEntry[] = [];
  for (const [ip, entry] of _memBans) {
    if (entry.expiresAt && now > entry.expiresAt) {
      _memBans.delete(ip);
      continue;
    }
    result.push(entry);
  }
  return result;
}

// ── Express middleware ──────────────────────────────────────
export async function ipBanMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (
    req.path.startsWith('/api/admin') ||
    req.path.startsWith('/api/health') ||
    req.path.startsWith('/api/docs')
  ) { next(); return; }

  try {
    const ip = getClientIp(req);
    const ban = await getBan(ip);
    if (!ban) { next(); return; }

    const remaining = ban.expiresAt
      ? Math.max(0, Math.ceil((ban.expiresAt - Date.now()) / 1000))
      : null;

    res.status(403).json({
      error: 'IP adresiniz engellenmiştir.',
      reason: ban.reason,
      bannedAt: ban.bannedAt,
      expiresAt: ban.expiresAt,
      ...(remaining !== null ? { remainingSeconds: remaining } : {}),
    });
  } catch (err) {
    console.error('[ipBan] middleware error:', (err as Error).message);
    next();
  }
}
