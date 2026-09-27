// server/socket/ipRateLimit.ts
// Sprint 104: socket/index.ts monolitinden ayrıştırıldı.
// IP bazlı socket rate limiting + otomatik geçici ban mantığı.
// Orijinal implementasyon sprint 97'de yazıldı; bu dosya saf bir taşıma (davranış değişikliği yok).

import logger from '../lib/logger';
import { envSafeInt } from '../lib/envNumbers';
import { getBan, banIp } from '../middleware/ipBan';

// ── IP RATE STORE: Redis-backed (multi-instance safe) ─────────
// Single-instance: Map kullanılır. Redis varsa (cluster/k8s) Redis'e geçilir.
import { cache as _rateCache, isRedisAvailable } from '../lib/redisAdapter';
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);
const _ipRateStore = new Map<string, number[]>(); // Fallback for single-instance

async function _ipWindowCount(key: string, windowMs: number, now: number): Promise<number> {
  if (isRedisAvailable()) {
    try {
      const count = await _rateCache.slidingWindowCount(`ipratelimit:${key}`, windowMs, now);
      if (count !== null) return count;
    } catch (err) {
      logger.warn({ event: 'socket_ip_ratelimit.redis.error', err: err instanceof Error ? err.message : String(err) },
        REDIS_CONFIGURED ? '[SocketRL] Redis window failed; rejecting connection.' : '[SocketRL] Redis window failed; using process-local quota');
      if (REDIS_CONFIGURED) return Number.MAX_SAFE_INTEGER;
    }
  } else if (REDIS_CONFIGURED) {
    return Number.MAX_SAFE_INTEGER;
  }
  const hits = (_ipRateStore.get(key) || []).filter(t => now - t < windowMs);
  hits.push(now);
  _ipRateStore.set(key, hits);
  return hits.length;
}

export const IP_SOCKET_RL = {
  connect:   { max: envSafeInt('RL_SOCKET_CONNECT_MAX', 20),  windowMs: 60_000  }, // 20 bağlantı/dk
  handshake: { max: envSafeInt('RL_SOCKET_HS_MAX', 30),  windowMs: 60_000  }, // 30 handshake/dk
};

// Otomatik geçici ban eşiği: IP bu kadar kez aşarsa geçici ban
const AUTO_BAN_THRESHOLD   = envSafeInt('RL_AUTO_BAN_THRESHOLD', 5);   // kaç ihlal sonrası
const AUTO_BAN_DURATION_MS = envSafeInt('RL_AUTO_BAN_DURATION', 15 * 60_000); // 15 dk

// ip → ihlal sayısı + zaman
// Redis-backed: multi-node deploy'da tüm instance'lar aynı ihlal sayacını görür.
// Redis yoksa in-memory fallback (tek instance için yeterli).
const _ipViolationsFallback = new Map<string, { count: number; firstAt: number }>();
const IP_VIOLATIONS_TTL_SEC = 3600; // 1 saat

async function _incrementIpViolation(ip: string, now: number): Promise<number> {
  if (isRedisAvailable()) {
    try {
      return await _rateCache.increment(`ipviolation:${ip}`, IP_VIOLATIONS_TTL_SEC);
    } catch (err) {
      logger.warn({ event: 'socket_ip_violation.redis.error', err: err instanceof Error ? err.message : String(err) },
        REDIS_CONFIGURED ? '[SocketRL] Redis violation counter failed; preserving rejection without local mutation.' : '[SocketRL] Redis violation counter failed; using process-local counter');
      if (REDIS_CONFIGURED) throw err;
    }
  } else if (REDIS_CONFIGURED) {
    throw new Error('Redis socket IP violation authority unavailable');
  }
  const rec = _ipViolationsFallback.get(ip) ?? { count: 0, firstAt: now };
  rec.count += 1;
  if (rec.count === 1) rec.firstAt = now;
  _ipViolationsFallback.set(ip, rec);
  return rec.count;
}

async function _clearIpViolation(ip: string): Promise<void> {
  if (isRedisAvailable()) {
    try { await _rateCache.del(`ipviolation:${ip}`); } catch (err) {
      logger.warn({ event: 'socket_ip_violation_clear.redis.error', err: err instanceof Error ? err.message : String(err) },
        '[SocketRL] Redis violation reset failed');
    }
  }
  _ipViolationsFallback.delete(ip);
}

setInterval(() => {
  const now = Date.now();
  const WINDOW = Math.max(...Object.values(IP_SOCKET_RL).map(r => r.windowMs), 120_000);
  // Redis-backed store doesn't need local cleanup (TTL handles it)
  if (!isRedisAvailable()) for (const [k, hits] of _ipRateStore) {
    const fresh = hits.filter(t => now - t < WINDOW);
    if (!fresh.length) _ipRateStore.delete(k); else _ipRateStore.set(k, fresh);
  }
  // In-memory fallback: eski ihlal kayıtlarını temizle (Redis TTL bunu otomatik yapar)
  if (!isRedisAvailable()) {
    for (const [ip, rec] of _ipViolationsFallback) {
      if (now - rec.firstAt > 3_600_000) _ipViolationsFallback.delete(ip);
    }
  }
}, 2 * 60_000).unref?.();

/**
 * IP bazlı rate check. İhlal sayısı AUTO_BAN_THRESHOLD'u aşarsa otomatik geçici ban uygular.
 * @returns {boolean} true = geçebilir, false = engellendi
 */
export async function ipRateCheck(ip: string, event: string): Promise<boolean> {
  const cfg = IP_SOCKET_RL[event as keyof typeof IP_SOCKET_RL];
  if (!cfg) return true;

  const key = `ip:${ip}:${event}`;
  const now = Date.now();
  const count = await _ipWindowCount(key, cfg.windowMs, now);

  if (count <= cfg.max) return true;
  return rejectWithViolation(ip, event);
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * AYNI NAT ARKASINDAKİ KİŞİLER BİRBİRİNİ BANLATMAZ (Final21 Faz 19)
 * ════════════════════════════════════════════════════════════════════════════
 * Bu kapı kimlik doğrulamasından ÖNCE çalışır ve yalnızca IP görüyordu: aynı ofis/okul/
 * CGNAT IP'sinden aynı dakikada 20'den fazla kişi Bridge'i açtığında aşımlar ihlal
 * sayılıyor ve 5 ihlalde o IP'nin TAMAMI 15 dk banlanıyordu. HTTP tarafındaki F21-11-04 ile
 * aynı model uygulanır:
 *   · imzası DOĞRULANMIŞ erişim jetonu → kişinin kendi kotası (`user:<id>`, `max`); kotasını
 *     aşan hesap reddedilir ama IP İHLALİ YAZILMAZ (komşularını banlatmaz);
 *   · aynı IP için ayrı ve geniş bir acil tavan (`ipa:<ip>`, `max × 20`); aşımı ihlaldir;
 *   · anonim / sahte / medya jetonu → davranış DEĞİŞMEDİ (`ipRateCheck`).
 * Geniş tavanı kullanmak için sunucu sırrıyla imzalanmış GEÇERLİ jetonlar gerekir.
 */
export const VERIFIED_IP_CEILING_FACTOR = 20;

export async function ipRateCheckFor(ip: string, event: string, verifiedUserId: string | null): Promise<boolean> {
  if (!verifiedUserId) return ipRateCheck(ip, event);
  const cfg = IP_SOCKET_RL[event as keyof typeof IP_SOCKET_RL];
  if (!cfg) return true;

  const now = Date.now();
  const ipCount = await _ipWindowCount(`ipa:${ip}:${event}`, cfg.windowMs, now);
  if (ipCount > cfg.max * VERIFIED_IP_CEILING_FACTOR) return rejectWithViolation(ip, event);

  const userCount = await _ipWindowCount(`user:${verifiedUserId}:${event}`, cfg.windowMs, now);
  if (userCount > cfg.max) {
    logger.warn({ event: 'socket_ratelimit.user_quota', userId: verifiedUserId, socketEvent: event, count: userCount, limit: cfg.max },
      '[SocketRL] Account exceeded its own connect quota; shared IP not penalised.');
    return false;
  }
  return true;
}

/** Aşım: ihlal sayılır; eşikte IP geçici olarak banlanır. Davranış Faz 19 öncesiyle aynı. */
async function rejectWithViolation(ip: string, event: string): Promise<boolean> {
  const now = Date.now();
  // Violation count is atomic in Redis as well; GET+SET would lose increments
  // when multiple websocket nodes reject the same IP concurrently.
  let violationCount: number;
  try { violationCount = await _incrementIpViolation(ip, now); }
  catch { return false; }

  logger.warn(`[SocketRL] IP rate limit aşıldı: ip=${ip} event=${event} ihlal=${violationCount}`);

  // Eşik aşıldıysa otomatik geçici ban
  if (violationCount >= AUTO_BAN_THRESHOLD) {
    try {
      const existing = await getBan(ip);
      if (!existing) {
        await banIp(ip, {
          reason:     `Otomatik ban: socket ${event} rate limit ${violationCount}x aşıldı`,
          durationMs: AUTO_BAN_DURATION_MS,
          adminId:    'system',
        });
        logger.warn(`[SocketRL] Otomatik IP ban uygulandı: ip=${ip} süre=${AUTO_BAN_DURATION_MS / 60_000}dk`);
        await _clearIpViolation(ip); // sıfırla
      }
    } catch (err) {
      logger.error('[SocketRL] Auto-ban hatası:', (err as Error).message);
    }
  }

  return false;
}
