// server/socket/ipRateLimit.ts
// Sprint 104: socket/index.ts monolitinden ayrıştırıldı.
// IP bazlı socket rate limiting + otomatik geçici ban mantığı.
// Orijinal implementasyon sprint 97'de yazıldı; bu dosya saf bir taşıma (davranış değişikliği yok).

import logger from '../lib/logger';
import { getBan, banIp } from '../middleware/ipBan';

// ── IP RATE STORE: Redis-backed (multi-instance safe) ─────────
// Single-instance: Map kullanılır. Redis varsa (cluster/k8s) Redis'e geçilir.
import { cache as _rateCache } from '../lib/redisAdapter';
const _ipRateStore = new Map<string, number[]>(); // Fallback for single-instance

async function _ipRateStoreGet(key: string): Promise<number[]> {
  if (_rateCache) {
    try {
      const val = await _rateCache.get<string>(`ipratelimit:${key}`);
      return val ? JSON.parse(val) : [];
    } catch { /* fallback */ }
  }
  return _ipRateStore.get(key) || [];
}

async function _ipRateStoreSet(key: string, hits: number[]): Promise<void> {
  if (_rateCache) {
    try {
      await _rateCache.set(`ipratelimit:${key}`, JSON.stringify(hits), 120);
      return;
    } catch { /* fallback to in-memory */ }
  }
  _ipRateStore.set(key, hits);
}

async function _ipRateStoreDel(key: string): Promise<void> {
  if (_rateCache) {
    try { await _rateCache.del(`ipratelimit:${key}`); return; } catch { /* fallback */ }
  }
  _ipRateStore.delete(key);
}

export const IP_SOCKET_RL = {
  connect:   { max: parseInt(process.env.RL_SOCKET_CONNECT_MAX ?? "") || 20,  windowMs: 60_000  }, // 20 bağlantı/dk
  handshake: { max: parseInt(process.env.RL_SOCKET_HS_MAX ?? "")      || 30,  windowMs: 60_000  }, // 30 handshake/dk
};

// Otomatik geçici ban eşiği: IP bu kadar kez aşarsa geçici ban
const AUTO_BAN_THRESHOLD   = parseInt(process.env.RL_AUTO_BAN_THRESHOLD ?? "") || 5;   // kaç ihlal sonrası
const AUTO_BAN_DURATION_MS = parseInt(process.env.RL_AUTO_BAN_DURATION ?? "") || 15 * 60_000; // 15 dk

// ip → ihlal sayısı + zaman
// Redis-backed: multi-node deploy'da tüm instance'lar aynı ihlal sayacını görür.
// Redis yoksa in-memory fallback (tek instance için yeterli).
const _ipViolationsFallback = new Map<string, { count: number; firstAt: number }>();
const IP_VIOLATIONS_TTL_SEC = 3600; // 1 saat

async function _getIpViolation(ip: string): Promise<{ count: number; firstAt: number } | null> {
  if (_rateCache) {
    try {
      const val = await _rateCache.get<string>(`ipviolation:${ip}`);
      return val ? JSON.parse(val) : null;
    } catch { /* fallback */ }
  }
  return _ipViolationsFallback.get(ip) ?? null;
}

async function _setIpViolation(ip: string, rec: { count: number; firstAt: number }): Promise<void> {
  if (_rateCache) {
    try {
      await _rateCache.set(`ipviolation:${ip}`, JSON.stringify(rec), IP_VIOLATIONS_TTL_SEC);
      return;
    } catch { /* fallback */ }
  }
  _ipViolationsFallback.set(ip, rec);
}

async function _delIpViolation(ip: string): Promise<void> {
  if (_rateCache) {
    try { await _rateCache.del(`ipviolation:${ip}`); return; } catch { /* fallback */ }
  }
  _ipViolationsFallback.delete(ip);
}

setInterval(() => {
  const now = Date.now();
  const WINDOW = Math.max(...Object.values(IP_SOCKET_RL).map(r => r.windowMs), 120_000);
  // Redis-backed store doesn't need local cleanup (TTL handles it)
  if (!_rateCache) for (const [k, hits] of _ipRateStore) {
    const fresh = hits.filter(t => now - t < WINDOW);
    if (!fresh.length) _ipRateStore.delete(k); else _ipRateStore.set(k, fresh);
  }
  // In-memory fallback: eski ihlal kayıtlarını temizle (Redis TTL bunu otomatik yapar)
  if (!_rateCache) {
    for (const [ip, rec] of _ipViolationsFallback) {
      if (now - rec.firstAt > 3_600_000) _ipViolationsFallback.delete(ip);
    }
  }
}, 2 * 60_000);

/**
 * IP bazlı rate check. İhlal sayısı AUTO_BAN_THRESHOLD'u aşarsa otomatik geçici ban uygular.
 * @returns {boolean} true = geçebilir, false = engellendi
 */
export async function ipRateCheck(ip: string, event: string): Promise<boolean> {
  const cfg = IP_SOCKET_RL[event as keyof typeof IP_SOCKET_RL];
  if (!cfg) return true;

  const key = `ip:${ip}:${event}`;
  const now = Date.now();
  const _stored = await _ipRateStoreGet(key);
  const hits = _stored.filter(t => now - t < cfg.windowMs);
  hits.push(now);
  await _ipRateStoreSet(key, hits);

  if (hits.length <= cfg.max) return true;

  // Limit aşıldı — ihlal sayacını artır (Redis-backed, multi-node safe)
  const existing_rec = await _getIpViolation(ip);
  const rec = existing_rec ?? { count: 0, firstAt: now };
  rec.count += 1;
  if (rec.count === 1) rec.firstAt = now;
  await _setIpViolation(ip, rec);

  logger.warn(`[SocketRL] IP rate limit aşıldı: ip=${ip} event=${event} ihlal=${rec.count}`);

  // Eşik aşıldıysa otomatik geçici ban
  if (rec.count >= AUTO_BAN_THRESHOLD) {
    try {
      const existing = await getBan(ip);
      if (!existing) {
        await banIp(ip, {
          reason:     `Otomatik ban: socket ${event} rate limit ${rec.count}x aşıldı`,
          durationMs: AUTO_BAN_DURATION_MS,
          adminId:    'system',
        });
        logger.warn(`[SocketRL] Otomatik IP ban uygulandı: ip=${ip} süre=${AUTO_BAN_DURATION_MS / 60_000}dk`);
        await _delIpViolation(ip); // sıfırla
      }
    } catch (err) {
      logger.error('[SocketRL] Auto-ban hatası:', (err as Error).message);
    }
  }

  return false;
}
