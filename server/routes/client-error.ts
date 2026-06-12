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
import { authMiddleware, castAuthed } from '../middleware/auth';
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
const REDIS_STATS_KEY = 'client_error_stats_v1';

async function persistStats() {
  await cache.set(REDIS_STATS_KEY, _errorStats, 24 * 60 * 60);
}

async function loadStats() {
  const fromRedis = await cache.get<ClientErrorStats>(REDIS_STATS_KEY);
  if (fromRedis && typeof fromRedis === 'object') {
    _errorStats.total = Number(fromRedis.total || 0);
    _errorStats.byType = fromRedis.byType || {};
    _errorStats.recent = Array.isArray(fromRedis.recent) ? fromRedis.recent.slice(-MAX_RECENT) : [];
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
  if (typeof report.type === 'string' && !validTypes.includes(report.type)) return false;
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
      source:    String(body.source  || '').slice(0, 300),
      line:      Number(body.line)   || 0,
      col:       Number(body.col)    || 0,
      stack:     String(body.stack   || '').slice(0, 3000),
      url:       String(body.url     || '').slice(0, 500),
      userAgent: String(body.userAgent || '').slice(0, 300),
      lang:      String(body.lang    || '').slice(0, 10),
      timestamp: body.timestamp || Date.now(),
      userId:    req.user?.id   || null,
      ip:        req.ip,
    };

    // İstatistik güncelle
    _errorStats.total += 1;
    _errorStats.byType[report.type] = (_errorStats.byType[report.type] || 0) + 1;
    _errorStats.recent.push(report);
    if (_errorStats.recent.length > MAX_RECENT) _errorStats.recent.shift();

    // Sunucu logu
    const logLevel = report.type === 'crash' ? 'error' : 'warn';
    logger[logLevel](
      { event: 'client.error.reported', type: report.type, userId: report.userId || 'anon', source: report.source, line: report.line },
      report.message
    );

    persistStats().catch(() => {});

    res.status(204).end();
  }
);

// GET /api/client-error/stats — sadece admin
router.get('/stats', authMiddleware, (req, res) => {
  if (!req.user?.isAdmin) return res.status(403).json({ error: 'Unauthorized' });
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
