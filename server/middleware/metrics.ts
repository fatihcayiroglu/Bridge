// server/middleware/metrics.ts
// Prometheus metrik toplama (prom-client)

import logger from '../lib/logger';
import { Request, Response, NextFunction } from 'express';
import { tryRequire } from '../lib/_optional-require';

const ENABLED = process.env.METRICS_ENABLED !== 'false';
const PREFIX  = process.env.METRICS_PREFIX || 'bridge_';

// prom-client types (optional import)
type Registry    = { metrics(): Promise<string>; contentType: string };
type Histogram   = { observe(labels: Record<string, string>, value: number): void };
type Counter     = { inc(labels?: Record<string, string>): void };
type Gauge       = { set(value: number): void };

let registry: Registry | undefined;
let httpRequestDuration!: Histogram;
let httpRequestTotal!:    Counter;
let httpErrorTotal!:      Counter;
let wsConnections!:       Gauge;
let wsEvents!:            Counter;
let dbQueryDuration!:     Histogram;
let dbQueryTotal!:        Counter;
let activeUsers!:         Gauge;
let activeSockets!:       Gauge;
let voiceRoomCount!:      Gauge;
let rateLimitHitsTotal!:  Counter;
let autoBanTotal!:        Counter;
let rateLimitAnomalyGauge!: Gauge;

if (ENABLED) {
  try {
    const prom = tryRequire<{
      Registry: new () => Registry & { register: unknown };
      collectDefaultMetrics(opts: { register: unknown; prefix: string }): void;
      Histogram: new (opts: Record<string, unknown>) => Histogram;
      Counter:   new (opts: Record<string, unknown>) => Counter;
      Gauge:     new (opts: Record<string, unknown>) => Gauge;
    }>('prom-client');
    if (!prom) throw new Error('prom-client not installed');

    const reg = new prom.Registry();
    registry = reg as unknown as Registry;
    prom.collectDefaultMetrics({ register: reg, prefix: PREFIX });

    httpRequestDuration = new prom.Histogram({
      name: `${PREFIX}http_request_duration_seconds`,
      help: 'HTTP istek süresi (saniye)',
      labelNames: ['method', 'route', 'status_code'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [reg],
    });

    httpRequestTotal = new prom.Counter({
      name: `${PREFIX}http_requests_total`,
      help: 'Toplam HTTP istek sayısı',
      labelNames: ['method', 'route', 'status_code'],
      registers: [reg],
    });

    httpErrorTotal = new prom.Counter({
      name: `${PREFIX}http_errors_total`,
      help: 'HTTP 4xx/5xx hata sayısı',
      labelNames: ['method', 'route', 'status_code'],
      registers: [reg],
    });

    wsConnections = new prom.Gauge({
      name: `${PREFIX}websocket_connections`,
      help: 'Aktif WebSocket bağlantısı sayısı',
      registers: [reg],
    });

    wsEvents = new prom.Counter({
      name: `${PREFIX}websocket_events_total`,
      help: 'İşlenen Socket.IO event sayısı',
      labelNames: ['event'],
      registers: [reg],
    });

    dbQueryDuration = new prom.Histogram({
      name: `${PREFIX}db_query_duration_seconds`,
      help: 'DB sorgu süresi (saniye)',
      labelNames: ['operation', 'collection'],
      buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.5, 1],
      registers: [reg],
    });

    dbQueryTotal = new prom.Counter({
      name: `${PREFIX}db_queries_total`,
      help: 'Toplam DB sorgu sayısı',
      labelNames: ['operation', 'collection'],
      registers: [reg],
    });

    activeUsers = new prom.Gauge({
      name: `${PREFIX}active_users`,
      help: 'Online kullanıcı sayısı',
      registers: [reg],
    });

    activeSockets = new prom.Gauge({
      name: `${PREFIX}active_sockets`,
      help: 'Toplam açık socket bağlantısı',
      registers: [reg],
    });

    voiceRoomCount = new prom.Gauge({
      name: `${PREFIX}voice_rooms`,
      help: 'Aktif ses odası sayısı',
      registers: [reg],
    });

    rateLimitHitsTotal = new prom.Counter({
      name: `${PREFIX}rate_limit_hits_total`,
      help: 'Rate limit aşım sayısı (429 yanıt)',
      labelNames: ['category', 'route'],
      registers: [reg],
    });

    autoBanTotal = new prom.Counter({
      name: `${PREFIX}auto_ban_total`,
      help: 'Otomatik IP ban sayısı',
      labelNames: ['category'],
      registers: [reg],
    });

    rateLimitAnomalyGauge = new prom.Gauge({
      name: `${PREFIX}rate_limit_anomaly_score`,
      help: 'Rate limit anomali skoru (>3 = anormal patlama)',
      registers: [reg],
    });

    logger.info('[Metrics] Prometheus metrik toplama aktif');
  } catch {
    logger.warn('[Metrics] prom-client bulunamadı — metrikler devre dışı. npm install prom-client');
  }
}

// ── Normalize route ──────────────────────────────────────────
function normalizeRoute(req: Request): string {
  const r = req as Request & { route?: { path: string }; baseUrl?: string };
  if (r.route?.path) {
    const base = r.baseUrl || '';
    return base + r.route.path;
  }
  return (req.path || (req as Request & { url?: string }).url || '/').replace(
    /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    '/:id'
  ).replace(/\/\d{6,}/g, '/:id');
}

// ── Express middleware ───────────────────────────────────────
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!ENABLED || !httpRequestDuration) { next(); return; }

  const startMs = Date.now();
  res.on('finish', () => {
    const durationSec = (Date.now() - startMs) / 1000;
    const labels = {
      method:      req.method,
      route:       normalizeRoute(req),
      status_code: String(res.statusCode),
    };
    httpRequestDuration.observe(labels, durationSec);
    httpRequestTotal.inc(labels);
    if (res.statusCode >= 400) httpErrorTotal.inc(labels);
  });
  next();
}

// ── /metrics endpoint handler ────────────────────────────────
export async function metricsEndpoint(req: Request, res: Response): Promise<void> {
  if (!ENABLED || !registry) {
    res.status(503).json({ error: 'Metrikler devre dışı' });
    return;
  }

  // Sprint 122 FIX 1: METRICS_SECRET production'da zorunlu.
  // Tanımlı değilse production'da endpoint tamamen kapatılır (503).
  // Dev/test ortamında uyarı verilir ama endpoint açık kalır.
  const secret = process.env.METRICS_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      res.status(503).json({ error: 'Metrikler yapılandırılmamış (METRICS_SECRET eksik)' });
      return;
    }
    // Dev: uyarı ver ama devam et
  } else {
    const auth = (req.headers.authorization as string) || '';
    if (auth !== `Bearer ${secret}`) {
      res.status(401).json({ error: 'Yetkisiz' });
      return;
    }
  }

  try {
    const socketMod = tryRequire<{
      socketUsers?: Map<string, { _id?: string; id?: string }>;
      voiceRooms?:  Record<string, unknown>;
    }>('../socket');
    const { socketUsers, voiceRooms } = socketMod ?? {};
    if (socketUsers) {
      const uniqueUsers = new Set([...socketUsers.values()].map(u => u._id || u.id));
      activeUsers?.set(uniqueUsers.size);
      activeSockets?.set(socketUsers.size);
    }
    if (voiceRooms) voiceRoomCount?.set(Object.keys(voiceRooms).length);
  } catch { /* socket modülü henüz yüklenmemişse atla */ }

  try {
    const data = await registry.metrics();
    res.set('Content-Type', registry.contentType);
    res.end(data);
  } catch (err) {
    res.status(500).json({ error: 'Metrik toplama hatası', detail: (err as Error).message });
  }
}

// ── DB sorgu izleyici ────────────────────────────────────────
type DbCollection = Record<string, (...args: unknown[]) => Promise<unknown>>;
type DbObject = Record<string, DbCollection>;

export function wrapDb(db: DbObject): DbObject {
  if (!ENABLED || !dbQueryDuration) return db;
  const TRACKED_OPS = ['find', 'findOne', 'insert', 'update', 'remove', 'count'];

  return new Proxy(db, {
    get(target, collectionName: string) {
      const collection = target[collectionName];
      if (typeof collection !== 'object' || collection === null) return collection;

      return new Proxy(collection, {
        get(col, opName: string) {
          const fn = col[opName];
          if (typeof fn !== 'function' || !TRACKED_OPS.includes(opName)) {
            return typeof fn === 'function' ? fn.bind(col) : fn;
          }
          return async function (...args: unknown[]) {
            const start = Date.now();
            const labels = { operation: opName, collection: collectionName };
            try {
              const result = await fn.apply(col, args);
              dbQueryTotal.inc(labels);
              dbQueryDuration.observe(labels, (Date.now() - start) / 1000);
              return result;
            } catch (err) {
              dbQueryTotal.inc({ ...labels, operation: `${opName}_err` });
              throw err;
            }
          };
        },
      });
    },
  });
}

// ── WebSocket event sayacı ───────────────────────────────────
export function trackWsEvent(event: string): void {
  if (ENABLED && wsEvents) {
    wsEvents.inc({ event: event.length > 40 ? event.slice(0, 40) : event });
  }
}

export function setWsConnectionCount(n: number): void {
  if (ENABLED && wsConnections) wsConnections.set(n);
}

// ── Rate limit ihlal sayacı ──────────────────────────────────
export function trackRateLimitHit(req: Request, category: string): void {
  if (!ENABLED || !rateLimitHitsTotal) return;
  const route = normalizeRoute(req);
  rateLimitHitsTotal.inc({ category: category || 'unknown', route });
}

// ── Otomatik ban sayacı ──────────────────────────────────────
export function trackAutoBan(category: string): void {
  if (ENABLED && autoBanTotal) autoBanTotal.inc({ category: category || 'http' });
}

// ── Anomali tespiti ──────────────────────────────────────────
const _anomalyWindow: { ts: number; count: number }[] = [];
const ANOMALY_CHECK_INTERVAL_MS = 30_000;
const ANOMALY_SHORT_WINDOW_MS   = 5 * 60_000;
const ANOMALY_LONG_WINDOW_MS    = 60 * 60_000;

function _recordRateLimitForAnomaly(): number {
  const now = Date.now();
  const recentCount = _anomalyWindow.reduce((s, e) => s + e.count, 0);
  _anomalyWindow.push({ ts: now, count: 0 });
  while (_anomalyWindow.length && now - _anomalyWindow[0].ts > ANOMALY_LONG_WINDOW_MS) {
    _anomalyWindow.shift();
  }
  return recentCount;
}

export function _bumpAnomalyCounter(): void {
  if (_anomalyWindow.length) {
    _anomalyWindow[_anomalyWindow.length - 1].count++;
  }
}

if (ENABLED) {
  setInterval(() => {
    if (!rateLimitAnomalyGauge || !_anomalyWindow.length) return;
    const now = Date.now();

    const shortSum = _anomalyWindow
      .filter(e => now - e.ts < ANOMALY_SHORT_WINDOW_MS)
      .reduce((s, e) => s + e.count, 0);

    const longSum = _anomalyWindow
      .filter(e => now - e.ts >= ANOMALY_SHORT_WINDOW_MS && now - e.ts < ANOMALY_LONG_WINDOW_MS)
      .reduce((s, e) => s + e.count, 0);

    const shortRate = shortSum / (ANOMALY_SHORT_WINDOW_MS / 1000);
    const longDurationSec = (ANOMALY_LONG_WINDOW_MS - ANOMALY_SHORT_WINDOW_MS) / 1000;
    const longRate = longDurationSec > 0 ? longSum / longDurationSec : 0;
    const score = longRate > 0 ? shortRate / longRate : (shortRate > 0 ? 3 : 0);
    rateLimitAnomalyGauge.set(Math.min(score, 100));

    if (score >= 3) {
      logger.warn(`[Metrics] ⚠️  Rate limit anomali tespiti: skor=${score.toFixed(2)} (anlık=${shortRate.toFixed(2)}/sn, baseline=${longRate.toFixed(2)}/sn)`);
    }
    _recordRateLimitForAnomaly();
  }, ANOMALY_CHECK_INTERVAL_MS).unref?.();
}

export const isEnabled = (): boolean => ENABLED && !!registry;
