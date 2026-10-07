// server/socket/socketRateLimit.ts
// Sprint 104: socket/index.ts monolitinden ayrıştırıldı.
// Sprint 105: Redis-backed store eklendi — çok-instance deploy'da kullanıcı bazlı
//             socket rate limiting artık tüm node'lar arasında senkronize çalışır.
//             IP rate limiting (ipRateLimit.ts) ile tutarlı pattern.

import logger from '../lib/logger';
import { cache as _rateCache, isRedisAvailable } from '../lib/redisAdapter';
import { envSafeInt } from '../lib/envNumbers';
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);

// ── KULLANICI BAZLI SOCKET RATE LIMITER ────────────────────────
// Redis varsa: tüm instance'lar aynı sayacı görür (cluster-safe)
// Redis yoksa: in-memory fallback (tek-instance için yeterli)
export const _socketRateStore = new Map<string, number[]>(); // in-memory fallback

/**
 * Soket olay hız sınırları.
 *
 * ── NEDEN ENV İLE AYARLANABİLİR ───────────────────────────────────────────
 * Bu değerler daha önce SABİT sayılardı. Projedeki DİĞER TÜM hız sınırları
 * (`middleware/rateLimit.ts`) zaten `RL_*` ortam değişkenleriyle
 * ayarlanabiliyordu; burası tutarsızdı ve test ortamında ölçüm yapmayı
 * imkânsız kılıyordu.
 *
 * VARSAYILANLAR DEĞİŞMEDİ. Aşağıdaki her sayı, öncesindeki sabit değerin
 * BİREBİR aynısıdır. Ortam değişkeni tanımlanmazsa üretim davranışı
 * bit düzeyinde AYNIDIR. Bu bir gevşetme değil, yalnızca DIŞARIDAN
 * AYARLANABİLİRLİK eklemesidir.
 *
 * ── `'*'` NEDEN ÖNEMLİ (ÖLÇÜLDÜ) ──────────────────────────────────────────
 * `'*'` kullanıcı BAŞINA dakikada 200 olaydır. WebRTC sinyalleşmesi olay
 * yoğundur (ICE adayları, offer/answer, yeniden pazarlık). Ölçüm:
 *
 *   Aynı kimlikle 3 ekran paylaşımı turu  → her biri 10.6 sn, SAĞLIKLI
 *   4. tur (aynı kimlik)                  → 70.4 sn, ses yolu 1/2 EKSİK
 *   5. tur (aynı kimlik)                  → hiç eşleşme yok (pcStates=NO_PC)
 *   4-5. tur (BAŞKA kimlik)               → yine 10.6 sn, SAĞLIKLI
 *
 * Tek değişken kullanıcı kimliğiydi: tarayıcı, sunucu, kanal ve kod aynıydı.
 * Sınır aşıldığında olaylar SESSİZCE düşürülür; belirti "ses kurulmuyor"
 * gibi görünür ve HTTP tarafında hiçbir hata görünmez.
 *
 * ÜRÜN NOTU: kamerayı açıp kapatan, ekran paylaşımını başlatıp durduran
 * GERÇEK bir kullanıcı da yoğun bir aramada bu bütçeye yaklaşabilir.
 * Üretim varsayılanı burada BİLİNÇLİ olarak değiştirilmemiştir; bu
 * raporlanan bir bulgudur.
 */
const _n = (name: string, d: number): number => envSafeInt(name, d);

export const SOCKET_RL: Record<string, { max: number; windowMs: number }> = {
  'message:send':  { max: _n('RL_SOCK_MSG_MAX', 20),  windowMs: _n('RL_SOCK_MSG_WIN', 10_000) },
  'dm:send':       { max: _n('RL_SOCK_DM_MAX', 10),  windowMs: _n('RL_SOCK_DM_WIN', 10_000) },
  'gdm:send':      { max: _n('RL_SOCK_GDM_MAX', 10),  windowMs: _n('RL_SOCK_GDM_WIN', 10_000) },
  'typing:start':  { max: _n('RL_SOCK_TYPING_MAX', 30),  windowMs: _n('RL_SOCK_TYPING_WIN', 5_000) },
  'voice:signal':  { max: _n('RL_SOCK_SIGNAL_MAX', 60),  windowMs: _n('RL_SOCK_SIGNAL_WIN', 10_000) },
  'soundboard:play': { max: _n('RL_SOCK_SOUNDBOARD_MAX', 6), windowMs: _n('RL_SOCK_SOUNDBOARD_WIN', 5_000) },
  'channel:join':  { max: _n('RL_SOCK_JOIN_MAX', 20),  windowMs: _n('RL_SOCK_JOIN_WIN', 10_000) },
  // Watch recomputes visibility for a whole server; one per server switch/reconnect is normal.
  'channels:watch': { max: _n('RL_SOCK_WATCH_MAX', 10), windowMs: _n('RL_SOCK_WATCH_WIN', 10_000) },
  '*':             { max: _n('RL_SOCK_EVENT_MAX', 200),  windowMs: _n('RL_SOCK_EVENT_WIN', 60_000) },
};

// ── Atomic Redis / in-memory sliding-window owner ───────────────────────────
// Shared by the per-event socket gate and the P7 B1 abuse policy
// (lib/abusePolicy.ts) so there is ONE cluster-wide counter implementation:
// Redis when configured (fail-closed: an unavailable authority counts as over
// the limit), a bounded process-local window only for deliberate single-node use.
export async function countInWindow(key: string, windowMs: number, now = Date.now()): Promise<number> {
  if (windowMs > _sweepHorizonMs) _sweepHorizonMs = windowMs;
  return _windowCount(key, windowMs, now);
}

// The in-memory sweep must never drop hits a caller's window still needs.
let _sweepHorizonMs = 120_000;

async function _windowCount(key: string, windowMs: number, now: number): Promise<number> {
  if (REDIS_CONFIGURED && !isRedisAvailable()) {
    logger.warn({ event: 'socket_ratelimit.redis.unavailable' },
      '[RateLimit] Socket Redis authority unavailable; rejecting event.');
    return Number.MAX_SAFE_INTEGER;
  }
  try {
    const count = await _rateCache.slidingWindowCount(`socketrl:${key}`, windowMs, now);
    if (count !== null) return count;
  } catch (err) {
    logger.warn({ event: 'socket_ratelimit.redis.error', err: err instanceof Error ? err.message : String(err) },
      REDIS_CONFIGURED ? '[RateLimit] Socket Redis window failed; rejecting event.' : '[RateLimit] Socket Redis window failed; using process-local quota');
    if (REDIS_CONFIGURED) return Number.MAX_SAFE_INTEGER;
  }
  const stored = _socketRateStore.get(key) ?? [];
  const hits = stored.filter(t => now - t < windowMs);
  hits.push(now);
  _socketRateStore.set(key, hits);
  return hits.length;
}

// ── In-memory fallback temizleyici (Redis TTL'i otomatik yönetir) ──
setInterval(() => {
  if (isRedisAvailable()) return; // Redis aktifse in-memory store kullanılmaz
  const now = Date.now();
  for (const [k, hits] of _socketRateStore) {
    const fresh = hits.filter(t => now - t < _sweepHorizonMs);
    if (!fresh.length) _socketRateStore.delete(k); else _socketRateStore.set(k, fresh);
  }
}, 2 * 60_000).unref?.();

/**
 * socketRateCheck — event bazlı kullanıcı rate kontrolü.
 * Redis varsa cluster-safe; yoksa in-memory fallback.
 */
export async function socketRateCheck(userId: string, event: string): Promise<boolean> {
  const cfg = SOCKET_RL[event] ?? SOCKET_RL['*']!;
  const key = `${userId}:${event}`;
  const now = Date.now();
  const count = await _windowCount(key, cfg.windowMs, now);
  return count <= cfg.max;
}

/** Global kullanıcı başına genel hız limiti */
export async function socketGlobalCheck(userId: string): Promise<boolean> {
  return socketRateCheck(userId, '*');
}

/**
 * createRateLimitedSocket — rate-limited proxy socket factory.
 * Her socket.on handler çalışmadan önce hem event hem global limit kontrol edilir.
 * Sprint 105: async socketRateCheck ile uyumlu — handler await ile beklenir.
 */
export function createRateLimitedSocket(
  socket: import('socket.io').Socket,
  userId: string,
): import('socket.io').Socket {
  return new Proxy(socket, {
    get(target, prop) {
      if (prop !== 'on') {
        return typeof (target as unknown as Record<string | symbol, unknown>)[prop] === 'function'
          ? (target as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[prop]!.bind(target)
          : (target as unknown as Record<string | symbol, unknown>)[prop];
      }
      return function(event: string, handler: (...args: unknown[]) => void) {
        // Lifecycle cleanup is mandatory correctness work, not user traffic.
        // Throttling it leaves ghost voice/stage/SFU/activity membership after a
        // busy client disconnects.
        if (event === 'disconnect' || event === 'disconnecting' || event === 'error') {
          target.on(event, handler);
          return;
        }
        target.on(event, async (...args: unknown[]) => {
          // Event bazlı limit
          if (SOCKET_RL[event] && !(await socketRateCheck(userId, event))) {
            logger.warn(`[RateLimit] Socket event throttled: ${event} user=${userId}`);
            target.emit('error:ratelimit', { event, message: 'Çok hızlı! Yavaşla.' });
            return;
          }
          // Global limit
          if (!(await socketGlobalCheck(userId))) {
            logger.warn(`[RateLimit] Socket global throttled: user=${userId}`);
            return;
          }
          return handler(...args);
        });
      };
    },
  }) as import('socket.io').Socket;
}
