// server/middleware/ip-ban.ts
// IP bazlı erişim engeli
// Redis varsa Redis'te tutar (tüm instance'lar senkron),
// yoksa in-memory Map'e düşer (tek node yeterli).

import { Request, Response, NextFunction } from 'express';

import logger from '../lib/logger';
import { getClientIp } from '../lib/clientIp';
import { isRedisAvailable, redisClient, redisAuthoritativeCommand } from '../lib/redisAdapter';
// ── Config ────────────────────────────────────────────────────────────────────

// NOT: `TRUSTED_PROXY_COUNT` burada TUTULMUYOR. Proxy guven modelinin TEK
// sahibi `lib/clientIp.ts`; ikinci bir kopya tam olarak bu programda kapatilan
// P1 sinifini (dort ayri, birbiriyle celisen yorum) geri getirirdi.

// ── Admin & health routes bypass list ────────────────────────────────────────

// `/metrics` BILINCLI olarak buradadir (v1.124).
//
// OLCULDU: Redis kesintisi sirasinda `/metrics` erisilemez hale geliyordu.
// Sonuc, gozlemlenebilirlik acisindan ters bir durumdu — izleme ucu, tam da
// izlemesi gereken arizada KARARIYORDU. Prometheus kazima yapamadigi icin
// `bridge_redis_up == 0` kurali HIC atesLENEMEZDI; operator yalnizca
// "Bridge tamamen dustu" sinyalini gorurdu ki bu YANILTICIDIR: surec
// ayakta ve fail-closed davraniyordu.
//
// `/api/health` zaten ayni nedenle muaftir. Izleme ve saglik uclari,
// izledikleri bagimliligin arkasinda OLMAMALIDIR.
//
// GUVENLIK: bu bir yetki gevsemesi DEGILDIR. `/metrics` ayrica
// `METRICS_SECRET` ile korunur (middleware/metrics.ts) ve production'da
// sir tanimli degilse uc tamamen kapalidir. Burada atlanan yalnizca IP
// yasagi kontroludur; kimlik dogrulama yerinde kalir.
const BYPASS_PREFIXES = ['/api/admin', '/api/health', '/api/docs', '/metrics'] as const;

// ── IP resolver ───────────────────────────────────────────────────────────────

// KANONIK COZUMLEYICIYE DEVREDILDI — burada BIR EKSIK indeks vardi:
//     idx = hops.length - N - 1
// ve saldirganin yazdigi ilk hop'a dusuyordu. Sonucu: yasak KAYDI dogru IP
// ile, yasak KONTROLU sahtelenebilir IP ile yapiliyordu; yani herhangi bir
// X-Forwarded-For basligi gondermek IP yasagini ATLATIYORDU.
// Ayrintili gerekce ve guven modeli: lib/clientIp.ts
export { getClientIp };

// ── Types ─────────────────────────────────────────────────────────────────────

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

// ── In-memory fallback ────────────────────────────────────────────────────────

const _memBans = new Map<string, BanEntry>();

// ── Redis interface (optional) ────────────────────────────────────────────────

interface RedisLike {
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
  setEx?(key: string, seconds: number, value: string): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
  mGet?(keys: string[]): Promise<(string | null)[]>;
  mget?(...keys: string[]): Promise<(string | null)[]>;
}

const REDIS_KEY_PREFIX = 'bridge:ipban:';
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);

function decodeBanEntry(raw: string, expectedIp?: string): BanEntry {
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object') throw new TypeError('Invalid persisted IP ban');
  const entry = value as Partial<BanEntry>;
  if (typeof entry.ip !== 'string' || !entry.ip || (expectedIp && entry.ip !== expectedIp) ||
      typeof entry.reason !== 'string' || !Number.isSafeInteger(entry.bannedAt) || (entry.bannedAt as number) < 0 ||
      !(entry.expiresAt === null || (Number.isSafeInteger(entry.expiresAt) && (entry.expiresAt as number) >= 0)) ||
      !(entry.adminId === null || typeof entry.adminId === 'string')) {
    throw new TypeError('Invalid persisted IP ban');
  }
  return entry as BanEntry;
}

type RedisOperationResult<T> = { used: false } | { used: true; value: T };

function _tryGetOptionalRedis(): RedisLike | null {
  // Only deliberate no-Redis mode may use an optional/local Redis facade.
  // A configured deployment is always routed through the bounded canonical
  // authority below, never through an unbounded raw client reference.
  if (REDIS_CONFIGURED) return null;
  if (isRedisAvailable()) {
    const client = redisClient();
    if (client) return client as unknown as RedisLike;
  }
  try {
    const g = global as unknown as { _bridgeRedis?: RedisLike & { status?: string } };
    if (g._bridgeRedis?.status === 'ready') return g._bridgeRedis;
  } catch { /* legacy/test hook unavailable */ }
  return null;
}

async function runIpBanRedis<T>(
  operation: string,
  command: (redis: RedisLike) => Promise<T>,
): Promise<RedisOperationResult<T>> {
  if (REDIS_CONFIGURED) {
    try {
      const value = await redisAuthoritativeCommand(`ip-ban ${operation}`, raw =>
        command(raw as RedisLike));
      return { used: true, value };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`IP-ban Redis coordination unavailable: ${detail}`, { cause: err });
    }
  }
  const redis = _tryGetOptionalRedis();
  if (!redis) return { used: false };
  return { used: true, value: await command(redis) };
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function banIp(
  ip: string,
  { reason = 'Admin ban', durationMs = null, adminId = null }: BanOptions = {}
): Promise<BanEntry> {
  if (!ip || ip === 'unknown') throw new Error('Geçersiz IP');

  const bannedAt  = Date.now();
  const expiresAt = durationMs ? bannedAt + durationMs : null;
  const entry: BanEntry = { ip, reason, bannedAt, expiresAt, adminId };

  const ttlSeconds = durationMs ? Math.ceil(durationMs / 1000) : 0;
  const result = await runIpBanRedis('write', async redis => {
    if (ttlSeconds > 0) {
      // SET with EX is one command on node-redis; setEx remains supported for
      // the legacy/test facade. Never split the TTL into a second command.
      if (redis.setEx) return redis.setEx(`${REDIS_KEY_PREFIX}${ip}`, ttlSeconds, JSON.stringify(entry));
      return redis.set(`${REDIS_KEY_PREFIX}${ip}`, JSON.stringify(entry), { EX: ttlSeconds });
    }
    return redis.set(`${REDIS_KEY_PREFIX}${ip}`, JSON.stringify(entry));
  });
  if (!result.used) _memBans.set(ip, entry);

  return entry;
}

export async function unbanIp(ip: string): Promise<void> {
  const result = await runIpBanRedis('delete', redis => redis.del(`${REDIS_KEY_PREFIX}${ip}`));
  if (!result.used) _memBans.delete(ip);
}

export async function getBan(ip: string): Promise<BanEntry | null> {
  const result = await runIpBanRedis('read', redis => redis.get(`${REDIS_KEY_PREFIX}${ip}`));
  if (result.used) {
    if (!result.value) return null;
    const entry = decodeBanEntry(result.value, ip);
    if (entry.expiresAt && Date.now() > entry.expiresAt) {
      await runIpBanRedis('delete expired', redis => redis.del(`${REDIS_KEY_PREFIX}${ip}`));
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
  const keysResult = await runIpBanRedis('list keys', redis => redis.keys(`${REDIS_KEY_PREFIX}*`));
  if (keysResult.used) {
    const keys = keysResult.value;
    if (!keys.length) return [];
    const valuesResult = await runIpBanRedis('list values', redis => {
      if (redis.mGet) return redis.mGet(keys);
      if (redis.mget) return redis.mget(...keys);
      throw new Error('Redis client does not support multi-get');
    });
    if (!valuesResult.used) throw new Error('IP-ban Redis coordination unavailable');
    const now = Date.now();
    return valuesResult.value
      .filter((v): v is string => v !== null)
      .map(v => decodeBanEntry(v))
      .filter(e => !e.expiresAt || e.expiresAt > now);
  }

  const now    = Date.now();
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

// ── Express middleware ────────────────────────────────────────────────────────

export async function ipBanMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  if (BYPASS_PREFIXES.some(prefix => req.path.startsWith(prefix))) {
    next();
    return;
  }

  try {
    const ip  = getClientIp(req);
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
    // Ban lookup is an access-control boundary. Storage uncertainty or
    // malformed persisted state must not become an implicit allow.
    logger.error('[ipBan] middleware error:', (err as Error).message);
    res.status(503).json({ error: 'IP erişim denetimi geçici olarak kullanılamıyor' });
  }
}
