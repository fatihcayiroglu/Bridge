// @ts-nocheck
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
import { redisClient, isRedisAvailable } from '../lib/redisAdapter';
import logger, { createLogger } from '../lib/logger';

const log = typeof createLogger === 'function' ? createLogger('federationRateLimit') : logger;

// ── Konfigürasyon ──────────────────────────────────────────────────────────
const GLOBAL_MAX     = parseInt(process.env.AP_INBOX_GLOBAL_MAX     || '500', 10);
const GLOBAL_WINDOW  = parseInt(process.env.AP_INBOX_GLOBAL_WINDOW  || '60',  10); // saniye
const PEER_MAX       = parseInt(process.env.AP_INBOX_PEER_MAX       || '100', 10);
const PEER_WINDOW    = parseInt(process.env.AP_INBOX_PEER_WINDOW    || '60',  10); // saniye
const BURST_MAX      = parseInt(process.env.AP_INBOX_BURST_MAX      || '20',  10); // 10 saniyede
const BURST_WINDOW   = 10; // saniye

// ── Yardımcı: sliding window sayacı ───────────────────────────────────────
async function checkLimit(key: string, max: number, windowSec: number): Promise<{
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}> {
  try {
    if (!isRedisAvailable()) return { allowed: true, remaining: max, retryAfter: 0 }; // Redis yok — fail open
    const r     = redisClient();
    if (!r) return { allowed: true, remaining: max, retryAfter: 0 };
    const now   = Date.now();
    const start = now - windowSec * 1000;
    const multi = r.multi();

    // Eski girişleri temizle
    multi.zRemRangeByScore(key, '-inf', start.toString());
    // Yeni girişi ekle
    multi.zAdd(key, { score: now, value: `${now}-${Math.random()}` });
    // Mevcut penceredeki toplam sayıyı al
    multi.zCard(key);
    // TTL set et (bellek temizliği)
    multi.expire(key, windowSec * 2);

    const results = await multi.exec();
    const count = (results?.[2] as number) ?? 0;

    const allowed   = count <= max;
    const remaining = Math.max(0, max - count);
    const retryAfter = allowed ? 0 : windowSec;

    return { allowed, remaining, retryAfter };
  } catch (err) {
    // Redis erişilemezse — fail open (kısıtlama yapma, log at)
    log.error({ event: 'rate_limit_redis_fail', err });
    return { allowed: true, remaining: max, retryAfter: 0 };
  }
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
  // Son çare: IP
  const forwarded = req.headers['x-forwarded-for'];
  return (typeof forwarded === 'string' ? forwarded.split(',')[0]!.trim() : req.ip) || 'unknown';
}

// ── Middleware: Global ActivityPub inbox limiti ───────────────────────────
export async function federationGlobalRateLimit(req: Request, res: Response, next: NextFunction) {
  const key    = 'ap:inbox:global';
  const result = await checkLimit(key, GLOBAL_MAX, GLOBAL_WINDOW);

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
