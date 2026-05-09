// server/routes/client-error.js
// Client-side hata raporlarını alır, loglar ve istatistik tutar.
// Kimliği doğrulanmış veya anonim olabilir.

'use strict';

const express = require('express');
const router  = express.Router();
const { rateLimit } = require('../middleware/rateLimit');
const { authMiddleware, castAuthed } = require('../middleware/auth');
const { cache } = require('../lib/redisAdapter');
const logger = require('../lib/logger');

// Hata raporları için hafıza içi istatistik (prod'da external log sistemine gönder)
const _errorStats = {
  total:   0,
  byType:  {},
  recent:  [] as any[],
};
const MAX_RECENT = 100;
const REDIS_STATS_KEY = 'client_error_stats_v1';

async function persistStats() {
  await cache.set(REDIS_STATS_KEY, _errorStats, 24 * 60 * 60);
}

async function loadStats() {
  const fromRedis = await cache.get(REDIS_STATS_KEY);
  if (fromRedis && typeof fromRedis === 'object') {
    _errorStats.total = Number(fromRedis.total || 0);
    _errorStats.byType = fromRedis.byType || {};
    _errorStats.recent = Array.isArray(fromRedis.recent) ? fromRedis.recent.slice(-MAX_RECENT) : [];
  }
}

loadStats().catch(() => {});

// Basit doğrulama
function isValidReport(body) {
  if (!body || typeof body !== 'object') return false;
  if (typeof body.message !== 'string') return false;
  if (body.message.length > 2000) return false;
  const validTypes = ['uncaught', 'unhandledrejection', 'resource', 'manual', 'crash'];
  if (body.type && !validTypes.includes(body.type)) return false;
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

module.exports = router;
export {};
