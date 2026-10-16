/**
 * @openapi
 * tags:
 *   - name: ClientError
 *     description: ClientError API endpoints

 *
 * /client-error:
 *   post:
 *     tags: [Health]
 *     summary: Client-side hata raporla
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               message: { type: string }
 *               stack:   { type: string }
 *               url:     { type: string }
 *     responses:
 *       200:
 *         description: Hata kaydedildi
 *
 * /client-error/recent:
 *   get:
 *     tags: [Health]
 *     summary: Son client hatalarini listele (admin)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Hata listesi
 *       403: { $ref: '#/components/responses/Forbidden' }
 */

// server/routes/client-error.ts
// Client-side hata raporlarını alır, loglar ve istatistik tutar.
// Kimliği doğrulanmış veya anonim olabilir.


import express from 'express';
const router  = express.Router();
import { rateLimit } from '../middleware/rateLimit';
import { authMiddleware } from '../middleware/auth';
import { databaseAdminOnly } from '../lib/adminAuthority';
import { cache } from '../lib/redisAdapter';
import logger from '../lib/logger';

// Hata raporları için hafıza içi istatistik (prod'da external log sistemine gönder)
interface ClientErrorStats {
  total: number;
  byType: Record<string, number>;
  recent: Record<string, unknown>[];
}

interface ClientErrorReportBody extends Record<string, unknown> {
  message: string;
  type?: string;
  stack?: string;
  url?: string;
  source?: string;
  line?: number | string;
  col?: number | string;
  userAgent?: string;
  lang?: string;
  timestamp?: number | string;
}

const _errorStats: ClientErrorStats = {
  total:   0,
  byType:  {},
  recent:  [],
};
const MAX_RECENT = 100;
const RECENT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const REDIS_STATS_KEY = 'client_error_stats_v1';

// A client-provided "source" is arbitrary text, often a script URL with query
// parameters or an inline filename. Do not persist or log URLs, credentials,
// paths or other caller-selected strings. Retain only stable diagnostic kinds.
const SAFE_ERROR_SOURCES = new Set([
  'ui', 'window', 'script', 'resource', 'worker', 'network', 'manual', 'promise',
]);
function safeErrorSource(value: unknown): string {
  return typeof value === 'string' && SAFE_ERROR_SOURCES.has(value) ? value : 'other';
}

function safeErrorLocation(value: unknown): number {
  const numeric = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d{1,7}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 1_000_000
    ? numeric : 0;
}

// B3 metadata minimization. Historical Redis reports included userId, IP,
// user-agent, URL and a client-selected timestamp. NEVER resurrect those fields
// while loading a legacy Redis snapshot. Use an explicit allowlist and only
// server-received timestamps; client clocks cannot extend retention.
function sanitizedRecent(value: unknown, now = Date.now()): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry): Record<string, unknown>[] => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const at = record.receivedAt;
    if (typeof at !== 'number' || !Number.isFinite(at) ||
        at > now || at <= now - RECENT_MAX_AGE_MS) return [];
    return [{
      type: typeof record.type === 'string' ? record.type.slice(0, 24) : 'unknown',
      message: typeof record.message === 'string' ? record.message.slice(0, 500) : '',
      source: safeErrorSource(record.source),
      line: safeErrorLocation(record.line),
      col: safeErrorLocation(record.col),
      stack: typeof record.stack === 'string' ? record.stack.slice(0, 3000) : '',
      receivedAt: at,
    }];
  }).slice(-MAX_RECENT);
}

async function persistStats() {
  _errorStats.recent = sanitizedRecent(_errorStats.recent);
  await cache.set(REDIS_STATS_KEY, _errorStats, 24 * 60 * 60);
}

async function loadStats() {
  const fromRedis = await cache.get<ClientErrorStats>(REDIS_STATS_KEY);
  if (fromRedis && typeof fromRedis === 'object') {
    _errorStats.total = Number(fromRedis.total || 0);
    _errorStats.byType = fromRedis.byType || {};
    _errorStats.recent = sanitizedRecent(fromRedis.recent);
  }
}

loadStats().catch(() => {});

// Basit doğrulama
function isValidReport(body: unknown): body is ClientErrorReportBody {
  if (!body || typeof body !== 'object') return false;
  const report = body as Record<string, unknown>;
  if (typeof report.message !== 'string') return false;
  if (report.message.length > 2000) return false;
  const validTypes = ['uncaught', 'unhandledrejection', 'resource', 'manual', 'crash'];
  if (report.type !== undefined &&
      (typeof report.type !== 'string' || !validTypes.includes(report.type))) return false;
  return true;
}

// POST /api/client-error
router.post(
  '/',
  rateLimit(20, 60_000, 'client-err'), // 20 rapor / dk / IP
  (req, res) => {
    const body = req.body;
    if (!isValidReport(body)) {
      return res.status(400).json({ error: 'Invalid error report payload' });
    }

    const report = {
      type:      body.type      || 'unknown',
      message:   String(body.message).slice(0, 500),
      source:    safeErrorSource(body.source),
      line:      safeErrorLocation(body.line),
      col:       safeErrorLocation(body.col),
      stack:     String(body.stack   || '').slice(0, 3000),
      // No IP, user id, URL, user-agent, locale or client-supplied timestamps
      // in Redis recent reports. Diagnostic message/stack may still contain
      // user-supplied information; they are subject to short, bounded retention.
      receivedAt: Date.now(),
    };

    // İstatistik güncelle
    _errorStats.total += 1;
    _errorStats.byType[report.type] = (_errorStats.byType[report.type] || 0) + 1;
    _errorStats.recent.push(report);
    _errorStats.recent = sanitizedRecent(_errorStats.recent);

    // Sunucu logu
    const logLevel = report.type === 'crash' ? 'error' : 'warn';
    logger[logLevel](
      { event: 'client.error.reported', type: report.type, source: report.source, line: report.line },
      'Client-side error reported'
    );

    persistStats().catch(() => {});

    res.status(204).end();
  }
);

// GET /api/client-error/stats — sadece admin
router.get('/stats', authMiddleware, databaseAdminOnly, (_req, res) => {
  _errorStats.recent = sanitizedRecent(_errorStats.recent);
  res.json({
    total:  _errorStats.total,
    byType: _errorStats.byType,
    recent: _errorStats.recent.slice(-20),
  });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
