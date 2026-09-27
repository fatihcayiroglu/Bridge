// server/middleware/metrics.ts
// Prometheus metrik toplama (prom-client)

import logger from '../lib/logger';
import { Request, Response, NextFunction } from 'express';
import { tryRequire } from '../lib/_optional-require';
import crypto from 'crypto';

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
let redisUpGauge!:        Gauge;
let dbUpGauge!:           Gauge;

// Bagimlilik modullerinin TEK SEFERLIK aramasi. `undefined` = henuz
// bakilmadi, `null` = modul yok (ve tekrar aranmayacak).
let _redisModCache: { isRedisAvailable?: () => boolean } | null | undefined;
interface DbProbePool { query(sql: string): Promise<unknown> }
interface DbLoaderModule { default?: { _pool?: DbProbePool & { totalCount?: number } } }
let _dbModCache: DbLoaderModule | null | undefined;

// ── VERİTABANI ERİŞİLEBİLİRLİK YOKLAMASI (F21-9-01) ─────────────────────────
// Kazımadan BAĞIMSIZ, sınırlı bir yoklama. İlk `/metrics` çağrısında başlar
// (izleme etkinse gösterge anlamlıdır), `unref` edilir ve süreç kapanışını
// engellemez. Her tur tek bir `SELECT 1` ve sabit bir zaman aşımıdır.
const DB_PROBE_INTERVAL_MS = 10_000;
const DB_PROBE_TIMEOUT_MS  = 3_000;
const _dbProbe: { up: boolean | null; at: number; timer: ReturnType<typeof setInterval> | null } = {
  up: null, at: 0, timer: null,
};

async function runDbProbe(pool: DbProbePool): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('db probe timeout')), DB_PROBE_TIMEOUT_MS);
        timeout.unref?.();
      }),
    ]);
    _dbProbe.up = true;
  } catch {
    _dbProbe.up = false;
  } finally {
    if (timeout) clearTimeout(timeout);
    _dbProbe.at = Date.now();
  }
}

function ensureDbProbe(pool: DbProbePool): void {
  if (_dbProbe.timer) return;
  void runDbProbe(pool);
  _dbProbe.timer = setInterval(() => { void runDbProbe(pool); }, DB_PROBE_INTERVAL_MS);
  _dbProbe.timer.unref?.();
}

/** Test kancası: yoklama durumunu sıfırlar. */
export function _resetDbProbeForTest(): void {
  if (_dbProbe.timer) clearInterval(_dbProbe.timer);
  _dbProbe.up = null; _dbProbe.at = 0; _dbProbe.timer = null;
}

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

    // ── BAGIMLILIK SAGLIGI (v1.124) ───────────────────────────────────────
    // v1.123 Redis kesintisini ve toparlanmasini KANITLADI, ama uyari
    // yazilamiyordu: Bridge bagimliliklarinin durumunu HIC yaymiyordu.
    // Uyari kurallari "Redis dustu" diyemiyordu cunku olculecek bir seri
    // yoktu. En kanitlanmis ariza modunun uyarisi olmamasi gercek bir
    // gozlemlenebilirlik bosluguydu.
    //
    // Kardinalite: etiket YOK, deger 0/1. Sinirsiz seri riski bulunmaz.
    redisUpGauge = new prom.Gauge({
      name: `${PREFIX}redis_up`,
      help: 'Redis erisilebilir mi (1) degil mi (0). REDIS_URL ayarli degilse 1 (tek dugum modu).',
      registers: [reg],
    });

    dbUpGauge = new prom.Gauge({
      name: `${PREFIX}db_up`,
      help: 'PostgreSQL son saglik yoklamasinda erisilebilir miydi (1/0)',
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
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK ACIK — SINIRSIZ METRIK KARDINALITESI (P2)
// ════════════════════════════════════════════════════════════════════════════
// `route` bir Prometheus ETIKETIDIR: her farkli deger KALICI yeni bir zaman
// serisi yaratir. Eski kod, Express hicbir rotayi eslestirmediginde HAM YOLA
// dusuyor ve yalnizca UUID/uzun-sayi normalizasyonu yapiyordu.
//
// SOMURU: kimlik dogrulamasi GEREKTIRMEYEN 404'ler.
//     GET /api/aaaa   GET /api/aaab   GET /api/aaac ...
// Her istek YENI bir seri uretirdi. Saldirgan ucuz isteklerle sunucu
// surecinde sinirsiz bellek buyumesi ve metrik arkasinda kardinalite
// patlamasi olusturabilirdi — izlemenin kendisi bir DoS yuzeyine donusurdu.
//
// DUZELTME: yalnizca GERCEKTEN eslesen rota kaliplari etiket olur. Eslesmeyen
// her sey TEK bir kovaya dusur. Sinyal kaybi yoktur: eslesen rotalar tam
// ayrintisini korur ve 404 hacmi zaten toplu olarak izlenmek istenir.
const UNMATCHED_ROUTE = '<unmatched>';

function normalizeRoute(req: Request): string {
  const r = req as Request & { route?: { path: string }; baseUrl?: string };
  if (r.route?.path) {
    const base = r.baseUrl || '';
    return base + r.route.path;
  }
  // Rota eslesmedi (404, middleware sonlandirmasi, statik dosya). Ham yolu
  // ETIKET OLARAK KULLANMA — saldirgan tarafindan sinirsiz secilebilir.
  return UNMATCHED_ROUTE;
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
// ── SABIT ZAMANLI SIR KARSILASTIRMASI ────────────────────────────────────────
// Onceden: auth !== `Bearer ${secret}`
// JS dize karsilastirmasi ILK FARKLI BAYTTA kisa devre yapar. Bu, metrik
// sirrinin bayt bayt zamanlama ile tahmin edilmesine kapi aralar. Uzunluk
// farki zaten sizar (kabul edilir); icerik karsilastirmasi sabit zamanlidir.
function sabitZamanliEsit(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

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
    if (!sabitZamanliEsit(auth, `Bearer ${secret}`)) {
      res.status(401).json({ error: 'Yetkisiz' });
      return;
    }
  }

  try {
    const socketMod = tryRequire<{
      socketUsers?: Map<string, { _id?: string; id?: string }>;
      voiceRooms?:  Record<string, unknown>;
      getVoiceRoomCount?: () => Promise<number>;
    }>('../socket', require);
    const { socketUsers, voiceRooms, getVoiceRoomCount } = socketMod ?? {};
    if (socketUsers) {
      const uniqueUsers = new Set([...socketUsers.values()].map(u => u._id || u.id));
      activeUsers?.set(uniqueUsers.size);
      activeSockets?.set(socketUsers.size);
    }
    // ── F21-6-01 ─────────────────────────────────────────────────────────────
    // Eskiden burada `Object.keys(voiceRooms).length` okunuyordu. `voiceRooms`
    // yalnizca BELLEK YEDEGINI sarar ve Redis yapilandirildiginda o yedege HIC
    // yazilmaz; dolayisiyla gosterge her URETIM kurulumunda sonsuza dek 0
    // gosteriyordu. Artik KANONIK sayim okunur (Redis-farkinda, kisa sureli
    // onbellekli). Eski yol yalnizca sayimi saglamayan eski bir modul icin
    // yedek olarak durur.
    if (typeof getVoiceRoomCount === 'function') {
      voiceRoomCount?.set(await getVoiceRoomCount());
    } else if (voiceRooms) {
      voiceRoomCount?.set(Object.keys(voiceRooms).length);
    }
  } catch { /* socket modülü henüz yüklenmemişse atla */ }

  // ── BAGIMLILIK DURUMU ────────────────────────────────────────────────────
  // Kasitli olarak UCUZ: yalnizca adapterin zaten tuttugu durumu okur,
  // her kazima isteginde yeni bir yoklama YAPMAZ. Kazima araligi, bir
  // saglik yoklamasi araligina donusmemelidir.
  // Modul aramasi BIR KEZ yapilir. Her kazimada yeniden `require` etmek,
  // sicak bir yolda gereksiz is ve olculebilir gecikme demekti (tam paket
  // kosumunda `/metrics` testi 10 sn zaman asimina dustu).
  try {
    if (_redisModCache === undefined) {
      _redisModCache = tryRequire<{ isRedisAvailable?: () => boolean }>('../lib/redisAdapter', require) ?? null;
    }
    const redisMod = _redisModCache;
    if (redisMod?.isRedisAvailable) {
      // REDIS_URL yoksa Redis bir bagimlilik DEGILDIR; tek dugum modu
      // saglikli sayilir, aksi halde uyari surekli calardi.
      const configured = Boolean(process.env.REDIS_URL);
      redisUpGauge?.set(!configured || redisMod.isRedisAvailable() ? 1 : 0);
    }
  } catch { /* adapter yuklu degilse atla */ }

  try {
    if (_dbModCache === undefined) {
      _dbModCache = tryRequire<DbLoaderModule>('../db/loader', require) ?? null;
    }
    const dbMod = _dbModCache;
    // ── Final21 Faz 9 — F21-9-01: bridge_db_up ARTIK GERÇEK ──────────────────
    // Eskiden burada `dbUpGauge.set(dbMod?.default ? 1 : 0)` vardı ve not
    // açıkça "havuz nesnesinin VARLIĞI" dediğini söylüyordu. GERÇEK KESİNTİDE
    // ÖLÇÜLDÜ: PostgreSQL 32 sn durdurulmuşken `/api/health` 503 verdi ama
    // `bridge_db_up` 1'de KALDI. `DatabaseUnavailable` alarmı (bridge_db_up == 0)
    // koruması gereken anda HİÇ ateşlenemiyordu.
    //
    // Kazıma hâlâ bir sağlık yoklamasına DÖNÜŞMEZ (eski notun haklı kaygısı):
    // yoklama AYRI, sınırlı, `unref`li bir zamanlayıcıda koşar; kazıma yalnızca
    // son sonucu OKUR. PostgreSQL havuzu yoksa (tek düğüm / test bağdaştırıcısı)
    // eski anlam korunur: katman yüklüyse 1.
    const pool = dbMod?.default?._pool;
    if (pool && typeof pool.query === 'function') {
      ensureDbProbe(pool);
      dbUpGauge?.set(_dbProbe.up === false ? 0 : 1);
    } else {
      dbUpGauge?.set(dbMod?.default ? 1 : 0);
    }
  } catch { dbUpGauge?.set(0); }

  // ── Final21 Faz 9 — F21-9-01: bridge_websocket_connections ARTIK BESLENİYOR ─
  // `setWsConnectionCount` ürün kodunda HİÇ çağrılmıyordu; gösterge sonsuza dek
  // 0'dı ve `WebSocketConnectionDrop` (delta < -100) hiçbir koşulda
  // ateşlenemiyordu. Kazımada motorun GERÇEK istemci sayısı okunur.
  try {
    const sockMod = tryRequire<{ getIo?: () => { engine?: { clientsCount?: number } } | null }>('../socket', require);
    const clients = sockMod?.getIo?.()?.engine?.clientsCount;
    if (typeof clients === 'number' && Number.isFinite(clients)) wsConnections?.set(clients);
  } catch { /* soket katmani yuklu degil */ }

  try {
    const data = await registry.metrics();
    res.set('Content-Type', registry.contentType);
    res.end(data);
  } catch (err) {
    res.status(500).json({ error: 'Metrik toplama hatası', detail: (err as Error).message });
  }
}

// ── PostgreSQL İSTEMCİ ENSTRÜMANTASYONU (Final21 Faz 9 — F21-9-01) ───────────
// `bridge_db_query_duration_seconds` ve `bridge_db_queries_total` TANIMLIYDI
// ama HİÇ beslenmiyordu: tek besleyici olan `wrapDb` ürün kodunda hiçbir yerden
// çağrılmıyordu. `SlowDbQueries` ve `DbQueryErrorSpike` alarmları bu yüzden
// ölüydü. Üstelik `wrapDb` koleksiyon API'sini sarar; sıcak SQL'in önemli kısmı
// (arama, depolar) doğrudan `pool.query` ile koşar ve yine görünmezdi — Faz 7'de
// yavaş olan arama sorgusu dahil.
//
// Doğru nokta İSTEMCİDİR: `pool.query` içeride bir istemci alıp `client.query`
// çağırır, işlemler (`getClient`) de `client.query` kullanır. Havuzun `connect`
// olayında her istemci BİR KEZ sarılır; her sorgu tam bir kez sayılır.
//
// KARDİNALİTE SINIRLI: `operation` sabit bir kümedir; `collection` ilk tablo
// adıdır, katı bir desenle doğrulanır ve en fazla `DB_COLLECTION_LABEL_CAP`
// farklı değer alır, fazlası `other` olur.
const DB_COLLECTION_LABEL_CAP = 128;
const _dbCollectionLabels = new Set<string>();
const PG_INSTRUMENTED = Symbol.for('bridge.metrics.pgInstrumented');

export function classifySql(sql: string): { operation: string; collection: string } {
  const head = sql.slice(0, 600).replace(/--[^\n]*\n/g, ' ').replace(/\s+/g, ' ').trim();
  const kw = (/^([A-Za-z]+)/.exec(head)?.[1] ?? '').toLowerCase();
  const operation =
    kw === 'select' || kw === 'insert' || kw === 'update' || kw === 'delete' || kw === 'with' ? kw
      : kw === 'begin' || kw === 'commit' || kw === 'rollback' || kw === 'savepoint' || kw === 'release' ? 'tx'
      : kw === 'create' || kw === 'alter' || kw === 'drop' ? 'ddl'
      : 'other';

  let raw = '';
  if (operation === 'insert') raw = /\bINTO\s+(?:ONLY\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)/i.exec(head)?.[1] ?? '';
  else if (operation === 'update') raw = /^UPDATE\s+(?:ONLY\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)/i.exec(head)?.[1] ?? '';
  else if (operation === 'select' || operation === 'delete' || operation === 'with') {
    raw = /\bFROM\s+(?:ONLY\s+)?("?[A-Za-z_][A-Za-z0-9_]*"?)/i.exec(head)?.[1] ?? '';
  }
  let collection = raw.replace(/"/g, '').toLowerCase();
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(collection)) collection = 'other';
  else if (!_dbCollectionLabels.has(collection)) {
    if (_dbCollectionLabels.size >= DB_COLLECTION_LABEL_CAP) collection = 'other';
    else _dbCollectionLabels.add(collection);
  }
  return { operation, collection };
}

interface InstrumentablePgClient { query: (...args: unknown[]) => unknown; [PG_INSTRUMENTED]?: boolean }

export function instrumentPgClient(client: InstrumentablePgClient): void {
  if (!ENABLED || !dbQueryDuration || !dbQueryTotal || !client || client[PG_INSTRUMENTED]) return;
  const original = client.query.bind(client);
  client.query = (...args: unknown[]) => {
    const first = args[0] as { text?: unknown; submit?: unknown } | string | undefined;
    const last = args[args.length - 1];
    // Geri çağrılı ve akış (Submittable) biçimleri DOKUNULMADAN geçer.
    if (typeof last === 'function' || (first && typeof first === 'object' && typeof first.submit === 'function')) {
      return original(...args);
    }
    const text = typeof first === 'string' ? first : typeof first?.text === 'string' ? first.text : '';
    const labels = classifySql(text);
    const start = process.hrtime.bigint();
    const result = original(...args) as Promise<unknown>;
    if (!result || typeof (result as Promise<unknown>).then !== 'function') return result;
    return result.then(
      (value) => {
        dbQueryTotal.inc(labels);
        dbQueryDuration.observe(labels, Number(process.hrtime.bigint() - start) / 1e9);
        return value;
      },
      (err: unknown) => {
        dbQueryTotal.inc({ ...labels, operation: `${labels.operation}_err` });
        throw err;
      },
    );
  };
  client[PG_INSTRUMENTED] = true;
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
/** Kısa pencerede anomali sayılabilmek için gereken en az isabet (F21-7-02). */
export const ANOMALY_MIN_SHORT_HITS = 20;
const ANOMALY_REWARN_MS         = 5 * 60_000;
let _anomalyActive = false;
let _anomalyLastWarnAt = 0;

function _recordRateLimitForAnomaly(): number {
  const now = Date.now();
  const recentCount = _anomalyWindow.reduce((s, e) => s + e.count, 0);
  _anomalyWindow.push({ ts: now, count: 0 });
  while (_anomalyWindow.length && now - (_anomalyWindow[0]?.ts ?? now) > ANOMALY_LONG_WINDOW_MS) {
    _anomalyWindow.shift();
  }
  return recentCount;
}

export function _bumpAnomalyCounter(): void {
  // The first implementation only incremented an existing bucket while the
  // periodic worker refused to run when the window was empty.  That created a
  // dead state: after process start no caller could ever create the first
  // bucket, so anomaly detection stayed disabled forever.  Seed the current
  // bucket on the first observed rate-limit hit; subsequent interval ticks
  // rotate/prune it through _recordRateLimitForAnomaly().
  if (!_anomalyWindow.length) {
    _anomalyWindow.push({ ts: Date.now(), count: 0 });
  }
  const bucket = _anomalyWindow[_anomalyWindow.length - 1];
  if (bucket) bucket.count++;
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

    // ── Final21 Faz 9 — F21-7-02: ASGARİ HACİM TABANI ────────────────────────
    // Eskiden `longRate > 0 ? oran : (shortRate > 0 ? 3 : 0)` idi. Açılıştan
    // hemen sonra taban çizgisi yokken kısa pencerede TEK bir isabet bile skoru
    // uyarı eşiğinin tam kendisine (3) taşıyordu. ÖLÇÜLDÜ: sunucu açılışından
    // beri `bridge_rate_limit_hits_total` = 1 iken 30 sn arayla ON uyarı
    // üretildi ve `toFixed(2)` 0.0033/sn'yi "0.00" bastığı için satır
    // "0.00/sn'ye karşı 0.00/sn anomali" gibi okunuyordu.
    //
    // Oran tabanlı bir dedektör, hacim anlamlı olmadan ORANDAN söz edemez.
    // Kısa pencerede `ANOMALY_MIN_SHORT_HITS`'ten az isabet anomali DEĞİLDİR
    // (tek bir meşru 429, kotasına takılan bir kullanıcıdır). Gerçek bir
    // kötüye kullanım dalgası yüzlerce 429 üretir ve tabanı rahatça aşar.
    // Eşik, yeniden ölçümden ÖNCE bu gerekçeyle belirlendi.
    const score = shortSum < ANOMALY_MIN_SHORT_HITS
      ? 0
      : (longRate > 0 ? shortRate / longRate : 3);
    rateLimitAnomalyGauge.set(Math.min(score, 100));

    // Günlük hijyeni — BASTIRMA DEĞİL: başlangıçta uyarılır, sürdükçe
    // `ANOMALY_REWARN_MS` aralıkla yeniden uyarılır, bitince bilgi verilir.
    // Sayılar oran yerine MUTLAK isabet olarak yazılır; yuvarlama yanıltmaz.
    const now2 = Date.now();
    const detail = `skor=${score.toFixed(2)} (son 5 dk: ${shortSum} isabet, önceki 55 dk: ${longSum} isabet)`;
    if (score >= 3) {
      if (!_anomalyActive || now2 - _anomalyLastWarnAt >= ANOMALY_REWARN_MS) {
        logger.warn(`[Metrics] ⚠️  Rate limit anomali tespiti: ${detail}`);
        _anomalyLastWarnAt = now2;
      }
      _anomalyActive = true;
    } else if (_anomalyActive) {
      logger.info(`[Metrics] Rate limit anomalisi sona erdi: ${detail}`);
      _anomalyActive = false;
    }
    _recordRateLimitForAnomaly();
  }, ANOMALY_CHECK_INTERVAL_MS).unref?.();
}

export const isEnabled = (): boolean => ENABLED && !!registry;

// Test kancasi: kardinalite sinirinin gercekten uygulandigini dogrulamak icin.
export const __normalizeRouteForTest = normalizeRoute;
export const __UNMATCHED_ROUTE = UNMATCHED_ROUTE;

/**
 * Test kancası (Final21 Faz 9 — F21-9-01): KAYITLI metriklerin adı, türü ve
 * etiketleri. Alarm kuralı sözleşme testi, kuralların sorguladığı her metriğin
 * ve etiketin sunucunun GERÇEK kaydında var olduğunu bununla doğrular.
 */
export function _metricCatalogForTest(): Array<{ name: string; type: string; labelNames: string[] }> {
  const reg = registry as unknown as {
    getMetricsAsArray?: () => Array<{ name: string; type?: string; labelNames?: string[] }>;
  } | undefined;
  return (reg?.getMetricsAsArray?.() ?? []).map((m) => ({
    name: m.name, type: String(m.type ?? ''), labelNames: [...(m.labelNames ?? [])],
  }));
}
