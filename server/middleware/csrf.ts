// server/middleware/csrf.ts — Bridge CSRF Protection Middleware
// Applies to all state-mutating requests (POST, PATCH, PUT, DELETE)
// from browser clients. API clients using bearer tokens are exempt.
//
// Usage in route files:
//   import { csrfMiddleware } from '../middleware/csrf';
//   router.post('/endpoint', authMiddleware, csrfMiddleware, handler);\n//
// Client must:
//   1. GET /api/auth/csrf-token  → { token }
//   2. Send header X-CSRF-Token: <token> on state-changing requests
//
// Sprint 75: Bot token bypass artık DB'de hash doğrulaması yapıyor.
// Sadece header varlığı yeterli değil; token geçerli bir bot kaydına sahip olmalı.
// Sprint 88: _verifyBotToken için 60s in-memory cache eklendi.
// Sprint 89: FIFO eviction → LRU ile değiştirildi (cache flooding koruması).

import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { verifyCsrfToken } from '../lib/security';
import { verifyToken } from './auth';

// Safe methods never need CSRF protection
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const EXEMPT_PATHS = new Set([
  '/login',
  '/register',
  '/refresh',
  '/captcha-config',
  '/health',
  '/health/live',
  '/health/ready',
  '/e2e',
]);

// ── Bot token NEGATIVE cache (LRU) ──────────────────────────
// Yalnızca GEÇERSİZ token hash'leri kısa süre cache'lenir. Pozitif doğrulama
// security/revocation boundary'dir ve her CSRF bypass denemesinde canonical DB
// kaydından yeniden okunur; aksi halde revoke edilmiş bir bot token bu worker'da
// TTL boyunca CSRF bypass etmeye devam ederdi. Negative cache sahte-token flood
// maliyetini bounded tutar ve yeni/yeniden etkinleştirilen token için en fazla
// kısa süreli availability etkisi yaratır; privilege uzatmaz.
// TTL: 60s, Max: 1 000 entries.
const BOT_TOKEN_CACHE_TTL_MS = 60_000;
const BOT_TOKEN_CACHE_MAX    = 1_000;
const _botTokenCache = new Map<string, { expiresAt: number }>();

function _isBotTokenNegativeCached(hash: string): boolean {
  const entry = _botTokenCache.get(hash);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) { _botTokenCache.delete(hash); return false; }
  // LRU: erişilen entry'yi sona taşı (Map insertion order)
  _botTokenCache.delete(hash);
  _botTokenCache.set(hash, entry);
  return true;
}

function _cacheInvalidBotToken(hash: string): void {
  // LRU eviction: en az kullanılan (Map'in ilk elemanı) atılır.
  // Sahte token flood'u aktif botları evict edemez; gerçek botlar yakın zamanda
  // kullanıldığı için sona taşınmış olur.
  if (_botTokenCache.size >= BOT_TOKEN_CACHE_MAX) {
    const lruKey = _botTokenCache.keys().next().value;
    if (lruKey !== undefined) _botTokenCache.delete(lruKey);
  }
  _botTokenCache.set(hash, { expiresAt: Date.now() + BOT_TOKEN_CACHE_TTL_MS });
}

/**
 * Sprint 75: Bot token'ı DB'deki hash ile doğrula.
 * Sprint 88: Sonuçlar 60s boyunca in-memory olarak önbelleğe alınır.
 * Sadece header varlığını kontrol etmek yetmez — token ele geçirilmiş olabilir.
 * Geçersiz token → CSRF bypass reddedilir.
 */
async function _verifyBotToken(token: string): Promise<boolean> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  // Only negative results are cached. A previously-valid token is always
  // re-read so revocation/disablement takes effect immediately on this node.
  if (_isBotTokenNegativeCached(tokenHash)) return false;

  try {
    const { default: db } = await import('../db/loader');
    const bot = await (db as unknown as {
      bots: { findOne(q: Record<string, unknown>): Promise<Record<string, unknown> | null> }
    }).bots.findOne({ tokenHash, active: true });
    if (bot !== null) return true;
    _cacheInvalidBotToken(tokenHash);
    return false;
  } catch {
    // DB erişimi başarısız → güvenli taraf: bypass izin verme.
    // Cache'e yazmıyoruz — geçici bir DB hatası kalıcı olarak negatif önbelleğe alınmamalı.
    return false;
  }
}

/**
 * Middleware: verify X-CSRF-Token header for mutating requests.
 * Bot token bypass artık DB doğrulaması gerektiriyor.
 */
export async function csrfMiddleware(req: Request, res: Response, next: NextFunction): Promise<void> {
  // Safe methods pass through
  if (SAFE_METHODS.has(req.method)) { next(); return; }

  // Bot/API key requests: Sprint 75'ten itibaren DB'de hash doğrulaması zorunlu.
  // SECURITY NOTE: Sadece header varlığı bypass için yeterli değil.
  // Token SHA-256 hash'i DB'deki kayıtla eşleşmezse CSRF kontrolü uygulanır.
  const botToken = req.headers['x-bot-token'] as string | undefined;
  const apiKey   = req.headers['x-api-key']   as string | undefined;
  if (botToken || apiKey) {
    const isValidBot = await _verifyBotToken(botToken ?? apiKey ?? '');
    if (isValidBot) { next(); return; }
    // Geçersiz bot token → CSRF bypass reddedildi; normal akışla devam
  }

  const token = req.headers['x-csrf-token'] as string | undefined;
  if (!token) {
    res.status(403).json({ error: 'CSRF token missing' });
    return;
  }

  const userId = (req as Request & { user?: { id: string } }).user?.id;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  let csrfValid: boolean;
  try {
    csrfValid = await verifyCsrfToken(userId, token);
  } catch {
    res.status(503).json({ error: 'CSRF security state unavailable' });
    return;
  }
  if (!csrfValid) {
    res.status(403).json({ error: 'CSRF token invalid or expired' });
    return;
  }

  next();
}

/**
 * Global /api middleware:
 * - Enforces CSRF for mutating browser requests that carry Bearer token.
 * - Keeps auth-free endpoints (login/register/refresh etc.) exempt.
 * - Sprint 75: Bot token bypass DB'de doğrulanıyor.
 */
export async function enforceApiCsrf(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (SAFE_METHODS.has(req.method)) { next(); return; }
  if (EXEMPT_PATHS.has(req.path)) { next(); return; }

  const botToken = req.headers['x-bot-token'] as string | undefined;
  const apiKey   = req.headers['x-api-key']   as string | undefined;
  if (botToken || apiKey) {
    const isValidBot = await _verifyBotToken(botToken ?? apiKey ?? '');
    if (isValidBot) { next(); return; }
  }

  const auth = (req.headers.authorization as string) || '';
  if (!auth.startsWith('Bearer ')) { next(); return; }
  const decoded = verifyToken(auth.slice(7));
  if (!(decoded as unknown as Record<string, unknown> | null)?.id) { next(); return; }

  const token = req.headers['x-csrf-token'] as string | undefined;
  if (!token) { res.status(403).json({ error: 'CSRF token missing' }); return; }
  let csrfValid: boolean;
  try {
    csrfValid = await verifyCsrfToken((decoded as { id: string }).id, token);
  } catch {
    res.status(503).json({ error: 'CSRF security state unavailable' });
    return;
  }
  if (!csrfValid) {
    res.status(403).json({ error: 'CSRF token invalid or expired' });
    return;
  }
  next();
}
