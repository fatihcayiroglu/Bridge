// server/middleware/federationRateLimit.ts
// Sprint 119: Tehdit modeli D6 — ActivityPub inbox flood giderildi.
//
// ActivityPub inbox endpoint'ine peer bazlı rate limiting uygular.
// Genel rate limiter'dan ayrı tutulur; federation trafiği farklı profil izler.
//
// Kullanım (server/routes/federation.ts veya server/index.ts):
//   import { federationInboxRateLimit, federationGlobalRateLimit }
//     from '../middleware/federationRateLimit';
//
//   router.post('/ap/users/:username/inbox',
//     federationGlobalRateLimit,
//     federationInboxRateLimit,
//     inboxHandler
//   );

import type { Request, Response, NextFunction } from 'express';
// Sprint 120: redisAdapter'dan paylaşımlı bağlantı kullan — ayrı Redis client açılmaz
import { cache, isRedisAvailable } from '../lib/redisAdapter';
import logger, { createLogger } from '../lib/logger';
import { getClientIp as canonicalClientIp } from '../lib/clientIp';
import { envSafeInt } from '../lib/envNumbers';

const log = typeof createLogger === 'function' ? createLogger('federationRateLimit') : logger;
const REDIS_CONFIGURED = Boolean(process.env.REDIS_URL);

// ── Konfigürasyon ──────────────────────────────────────────────────────────
const GLOBAL_MAX = envSafeInt('AP_INBOX_GLOBAL_MAX', 500, { min: 1, max: 100_000 });
const GLOBAL_WINDOW = envSafeInt('AP_INBOX_GLOBAL_WINDOW', 60, { min: 1, max: 86_400 }); // saniye
const PEER_MAX = envSafeInt('AP_INBOX_PEER_MAX', 100, { min: 1, max: 10_000 });
const PEER_WINDOW = envSafeInt('AP_INBOX_PEER_WINDOW', 60, { min: 1, max: 86_400 }); // saniye
const BURST_MAX = envSafeInt('AP_INBOX_BURST_MAX', 20, { min: 1, max: 1_000 }); // 10 saniyede
const BURST_WINDOW   = 10; // saniye

// ── Yardımcı: sliding window sayacı ───────────────────────────────────────
// Redis kesintisi, kimliği doğrulanmamış federation trafiğini sınırsız hale
// getirmemeli. Redis bilinçli olarak yapılandırılmamış single-node modda bounded
// local pencere kullanılır; REDIS_URL verilmişse shared authority kaybı 503 ile
// fail-closed olur ve process-local quota'ya sessiz downgrade yapılmaz.
const _localWindows = new Map<string, number[]>();

function localWindowCount(key: string, windowMs: number, now: number): number {
  const cutoff = now - windowMs;
  const previous = _localWindows.get(key) ?? [];
  const live = previous.filter(ts => ts > cutoff);
  live.push(now);
  _localWindows.set(key, live);
  return live.length;
}

export function _resetFederationRateLimitFallbackForTest(): void {
  _localWindows.clear();
}

async function checkLimit(key: string, max: number, windowSec: number): Promise<{
  allowed: boolean;
  remaining: number;
  retryAfter: number;
  unavailable: boolean;
}> {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  let count: number;
  let unavailable = false;
  if (isRedisAvailable()) {
    try {
      const sharedCount = await cache.slidingWindowCount(key, windowMs, now);
      if (sharedCount === null && REDIS_CONFIGURED) unavailable = true;
      count = sharedCount ?? localWindowCount(key, windowMs, now);
    } catch (err) {
      log.error({ event: 'rate_limit_redis_fail', err });
      if (REDIS_CONFIGURED) { unavailable = true; count = max + 1; }
      else count = localWindowCount(key, windowMs, now);
    }
  } else if (REDIS_CONFIGURED) {
    unavailable = true;
    count = max + 1;
  } else {
    count = localWindowCount(key, windowMs, now);
  }

  const allowed = !unavailable && count <= max;
  const remaining = Math.max(0, max - count);
  return { allowed, remaining, retryAfter: allowed ? 0 : windowSec, unavailable };
}

// ── Peer host çıkarımı ────────────────────────────────────────────────────
function extractPeerHost(req: Request): string {
  // HTTP Signature header'ından keyId → peer host al
  const sig = req.headers['signature'] as string | undefined;
  if (sig) {
    const keyIdMatch = sig.match(/keyId="([^"]+)"/);
    if (keyIdMatch?.[1]) {
      try { return new URL(keyIdMatch[1]).hostname; } catch { /* ignore */ }
    }
  }
  // Fallback: aktivite actor'undan
  const body = req.body as { actor?: string; '@context'?: unknown } | undefined;
  if (body?.actor) {
    try { return new URL(body.actor).hostname; } catch { /* ignore */ }
  }
  // Son çare: IP — KANONIK cozumleyici.
  // Onceden `forwarded.split(',')[0]` kullaniliyordu; bu zincirin ILK
  // hop'udur ve TAMAMEN istemci tarafindan yazilir. Uzak eslerin hiz
  // sinirini sahte bir XFF ile atlamasina izin veriyordu.
  return canonicalClientIp(req) || 'unknown';
}

// ── Middleware: Global ActivityPub inbox limiti ───────────────────────────
export async function federationGlobalRateLimit(req: Request, res: Response, next: NextFunction) {
  const key    = 'ap:inbox:global';
  const result = await checkLimit(key, GLOBAL_MAX, GLOBAL_WINDOW);

  if (result.unavailable) {
    res.setHeader('Retry-After', 1);
    return res.status(503).json({ error: 'Federation rate limit service unavailable' });
  }

  res.setHeader('X-AP-RateLimit-Limit',     GLOBAL_MAX);
  res.setHeader('X-AP-RateLimit-Remaining', result.remaining);

  if (!result.allowed) {
    log.warn({ event: 'ap_global_rate_limit', remaining: 0 });
    res.setHeader('Retry-After', result.retryAfter);
    return res.status(429).json({
      error:      'Too Many Requests',
      retryAfter: result.retryAfter,
    });
  }

  next();
}

// ── Middleware: Peer bazlı ActivityPub inbox limiti ──────────────────────
export async function federationInboxRateLimit(req: Request, res: Response, next: NextFunction) {
  const peer = extractPeerHost(req);

  // Burst kontrolü (10 saniyede max BURST_MAX istek)
  const burstKey  = `ap:inbox:burst:${peer}`;
  const burstResult = await checkLimit(burstKey, BURST_MAX, BURST_WINDOW);
  if (burstResult.unavailable) {
    res.setHeader('Retry-After', 1);
    return res.status(503).json({ error: 'Federation rate limit service unavailable' });
  }
  if (!burstResult.allowed) {
    log.warn({ event: 'ap_burst_rate_limit', peer, remaining: 0 });
    res.setHeader('Retry-After', BURST_WINDOW);
    return res.status(429).json({
      error:      'Burst limit exceeded',
      peer,
      retryAfter: BURST_WINDOW,
    });
  }

  // Pencere bazlı kontrol (dakikada max PEER_MAX istek)
  const peerKey  = `ap:inbox:peer:${peer}`;
  const peerResult = await checkLimit(peerKey, PEER_MAX, PEER_WINDOW);
  if (peerResult.unavailable) {
    res.setHeader('Retry-After', 1);
    return res.status(503).json({ error: 'Federation rate limit service unavailable' });
  }

  res.setHeader('X-AP-Peer-RateLimit-Limit',     PEER_MAX);
  res.setHeader('X-AP-Peer-RateLimit-Remaining', peerResult.remaining);

  if (!peerResult.allowed) {
    log.warn({ event: 'ap_peer_rate_limit', peer, remaining: 0 });
    res.setHeader('Retry-After', peerResult.retryAfter);
    return res.status(429).json({
      error:      'Peer rate limit exceeded',
      peer,
      retryAfter: peerResult.retryAfter,
    });
  }

  log.debug({ event: 'ap_inbox_allowed', peer, remaining: peerResult.remaining });
  next();
}
