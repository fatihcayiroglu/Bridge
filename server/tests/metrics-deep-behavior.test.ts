import { EventEmitter } from 'events';

type Call = { kind: string; labels?: Record<string, unknown>; value?: number };

const savedEnv = { ...process.env };
let calls: Call[] = [];
// Yayilimla cagriliyor (`metrics(...args)`); imza rest parametre almali.
let registryMetrics = jest.fn(async (..._args: unknown[]) => '# bridge_metric 1\n');
let socketModule: any = undefined;
let throwSocket = false;

class Registry {
  register = {};
  contentType = 'text/plain; version=0.0.4';
  metrics = (...args: unknown[]) => registryMetrics(...args);
}
class Histogram {
  constructor(_opts: any) {}
  observe(labels: any, value: number) { calls.push({ kind: 'hist', labels, value }); }
}
class Counter {
  constructor(_opts: any) {}
  inc(labels?: any) { calls.push({ kind: 'counter', labels }); }
}
class Gauge {
  constructor(_opts: any) {}
  set(value: number) { calls.push({ kind: 'gauge', value }); }
}

const fakeProm = {
  Registry,
  Histogram,
  Counter,
  Gauge,
  collectDefaultMetrics: jest.fn(),
};

function restoreEnv() {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
}

function loadMetrics(opts: { enabled?: boolean; prom?: boolean; socket?: any; socketThrows?: boolean } = {}) {
  jest.resetModules();
  calls = [];
  registryMetrics = jest.fn(async () => '# bridge_metric 1\n');
  socketModule = opts.socket;
  throwSocket = !!opts.socketThrows;
  process.env.NODE_ENV = 'test';
  process.env.METRICS_ENABLED = opts.enabled === false ? 'false' : 'true';
  delete process.env.METRICS_SECRET;
  const promEnabled = opts.prom !== false;
  jest.doMock('../lib/_optional-require', () => ({
    tryRequire: jest.fn((id: string) => {
      if (id === 'prom-client') return promEnabled ? fakeProm : undefined;
      if (id === '../socket') {
        if (throwSocket) throw new Error('socket not ready');
        return socketModule;
      }
      return undefined;
    }),
  }));
  return require('../middleware/metrics');
}

function fakeReq(overrides: any = {}) {
  return { method: 'GET', route: { path: '/:id' }, baseUrl: '/api/items', headers: {}, ...overrides } as any;
}
function fakeRes(statusCode = 200) {
  const res: any = new EventEmitter();
  res.statusCode = statusCode;
  res.status = jest.fn((n: number) => { res.statusCode = n; return res; });
  res.json = jest.fn(() => res);
  res.set = jest.fn(() => res);
  res.end = jest.fn(() => res);
  return res;
}

describe('metrics production behavior and anomaly state machine', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.dontMock('../lib/_optional-require');
    restoreEnv();
  });

  it('disabled metrics are a true no-op across middleware, DB and counters', () => {
    const m = loadMetrics({ enabled: false });
    const next = jest.fn();
    m.metricsMiddleware(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    const db = { users: { find: jest.fn(async () => ['x']) } };
    expect(m.wrapDb(db)).toBe(db);
    m.trackWsEvent('x'); m.setWsConnectionCount(5); m.trackRateLimitHit(fakeReq(), 'auth'); m.trackAutoBan('auth');
    expect(m.isEnabled()).toBe(false);
    expect(calls).toEqual([]);
  });

  it('missing optional prom-client degrades without partially enabled metrics', () => {
    const m = loadMetrics({ prom: false });
    expect(m.isEnabled()).toBe(false);
    const next = jest.fn();
    m.metricsMiddleware(fakeReq(), fakeRes(), next);
    expect(next).toHaveBeenCalled();
    expect(m.wrapDb({ x: {} })).toEqual({ x: {} });
  });

  it('HTTP middleware records matched success and unmatched error labels on finish', () => {
    const m = loadMetrics();
    const next = jest.fn();
    const ok = fakeRes(204);
    m.metricsMiddleware(fakeReq(), ok, next);
    ok.emit('finish');
    expect(next).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'hist', labels: { method: 'GET', route: '/api/items/:id', status_code: '204' } }),
      expect.objectContaining({ kind: 'counter', labels: { method: 'GET', route: '/api/items/:id', status_code: '204' } }),
    ]));

    calls = [];
    const err = fakeRes(503);
    m.metricsMiddleware(fakeReq({ method: 'POST', route: undefined, baseUrl: '' }), err, jest.fn());
    err.emit('finish');
    const errorCounters = calls.filter(c => c.kind === 'counter');
    expect(errorCounters.some(c => c.labels?.route === '<unmatched>' && c.labels?.status_code === '503')).toBe(true);
    expect(errorCounters).toHaveLength(2); // request total + error total
  });

  it('metrics endpoint updates socket gauges and returns registry output', async () => {
    const m = loadMetrics({ socket: {
      socketUsers: new Map([['a', { _id: 'u1' }], ['b', { _id: 'u1' }], ['c', { id: 'u2' }]]),
      voiceRooms: { one: {}, two: {} },
    } });
    const res = fakeRes();
    await m.metricsEndpoint(fakeReq(), res);
    expect(res.set).toHaveBeenCalledWith('Content-Type', 'text/plain; version=0.0.4');
    expect(res.end).toHaveBeenCalledWith('# bridge_metric 1\n');
    expect(calls.filter(c => c.kind === 'gauge').map(c => c.value)).toEqual(expect.arrayContaining([2, 3, 2]));
  });

  it('metrics endpoint contains socket import failure but surfaces registry failure', async () => {
    const m = loadMetrics({ socketThrows: true });
    registryMetrics.mockRejectedValueOnce(new Error('registry failed'));
    const res = fakeRes();
    await m.metricsEndpoint(fakeReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'Metrik toplama hatası', detail: 'registry failed' });
  });

  it('production endpoint fails closed without secret and constant-time auth rejects wrong lengths/content', async () => {
    const m = loadMetrics();
    process.env.NODE_ENV = 'production';
    let res = fakeRes();
    await m.metricsEndpoint(fakeReq(), res);
    expect(res.status).toHaveBeenCalledWith(503);

    process.env.METRICS_SECRET = 'abcd';
    res = fakeRes();
    await m.metricsEndpoint(fakeReq({ headers: { authorization: 'Bearer abc' } }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    res = fakeRes();
    await m.metricsEndpoint(fakeReq({ headers: { authorization: 'Bearer abce' } }), res);
    expect(res.status).toHaveBeenCalledWith(401);
    res = fakeRes();
    await m.metricsEndpoint(fakeReq({ headers: { authorization: 'Bearer abcd' } }), res);
    expect(res.end).toHaveBeenCalled();
  });

  it('wrapDb observes tracked success/error while preserving non-tracked members and binding', async () => {
    const m = loadMetrics();
    const users = {
      tag: 'users',
      find: jest.fn(async function (this: any, q: any) { return [this.tag, q]; }),
      update: jest.fn(async () => { throw new Error('db down'); }),
      custom: function (this: any) { return this.tag; },
      value: 7,
    };
    const wrapped = m.wrapDb({ users, scalar: 12 } as any);
    await expect(wrapped.users.find('q')).resolves.toEqual(['users', 'q']);
    await expect(wrapped.users.update('x')).rejects.toThrow('db down');
    expect((wrapped.users as any).custom()).toBe('users');
    expect((wrapped.users as any).value).toBe(7);
    expect((wrapped as any).scalar).toBe(12);
    const counters = calls.filter(c => c.kind === 'counter').map(c => c.labels);
    expect(counters).toEqual(expect.arrayContaining([
      { operation: 'find', collection: 'users' },
      { operation: 'update_err', collection: 'users' },
    ]));
  });

  it('WebSocket/rate-limit/ban helpers cap label cardinality and apply fallback categories', () => {
    const m = loadMetrics();
    m.trackWsEvent('x'.repeat(60));
    m.setWsConnectionCount(9);
    m.trackRateLimitHit(fakeReq({ route: undefined }), '');
    m.trackAutoBan('');
    const counters = calls.filter(c => c.kind === 'counter').map(c => c.labels);
    expect(counters).toEqual(expect.arrayContaining([
      { event: 'x'.repeat(40) },
      { category: 'unknown', route: '<unmatched>' },
      { category: 'http' },
    ]));
    expect(calls).toContainEqual({ kind: 'gauge', value: 9 });
  });

  it('first anomaly bump seeds the window so detector can actually run', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(1_000_000));
    const m = loadMetrics();

    // Regression: before the fix this did nothing when the window was empty,
    // and the interval also returned on an empty window. Detection was dead.
    //
    // Final21 Faz 9 (F21-7-02): bu test eskiden IKI isabetle skor >= 3
    // bekliyordu. Amaci CANLILIKTI (dedektor gercekten calisiyor mu) — ama
    // iki isabetin anomali sayilmasi tam olarak olculen sahte alarmdi (tek bir
    // 429 ON uyari uretti). Canlilik iddiasi KORUNUR: asgari hacim tabanina
    // ulasan isabetler skoru yine esige tasir.
    for (let i = 0; i < m.ANOMALY_MIN_SHORT_HITS; i++) m._bumpAnomalyCounter();
    await jest.advanceTimersByTimeAsync(30_000);

    // `Call.value` ISTEGE BAGLIdir; `Math.max` `number` ister. Sayisal
    // olanlar SUZULUR — boylece 'deger yok' durumu sessizce `NaN` uretmez.
    const anomalyGauge = calls
      .filter(c => c.kind === 'gauge')
      .map(c => c.value)
      .filter((v): v is number => typeof v === 'number');
    expect(anomalyGauge.length).toBeGreaterThan(0);
    expect(Math.max(...anomalyGauge)).toBeGreaterThanOrEqual(3);
  });

  // ── Final21 Faz 9 — F21-7-02 ───────────────────────────────────────────────
  // OLCULDU: sunucu acilisindan beri TEK bir hiz siniri isabeti (e2e kurulumunun
  // kayit denemesi) 30 sn arayla ON "anomali" uyarisi uretti; satir
  // "0.00/sn'ye karsi 0.00/sn" diye okunuyordu.
  it('a handful of rate-limit hits below the volume floor is NOT an anomaly and does not warn', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(2_000_000));
    const m = loadMetrics();
    const logger = require('../lib/logger').default;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);

    for (let i = 0; i < m.ANOMALY_MIN_SHORT_HITS - 1; i++) m._bumpAnomalyCounter();
    // Tam kisa pencere boyunca (5 dk) her 30 sn kontrol edilir.
    await jest.advanceTimersByTimeAsync(5 * 60_000);

    const anomalyGauge = calls.filter(c => c.kind === 'gauge').map(c => c.value)
      .filter((v): v is number => typeof v === 'number');
    expect(anomalyGauge.length).toBeGreaterThan(0);
    expect(Math.max(...anomalyGauge)).toBe(0);
    expect(warn.mock.calls.filter(c => String(c[0]).includes('anomali'))).toHaveLength(0);
  });

  it('a sustained anomaly warns at onset, re-warns while it lasts, and reports when it clears', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date(3_000_000));
    const m = loadMetrics();
    const logger = require('../lib/logger').default;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const info = jest.spyOn(logger, 'info').mockImplementation(() => undefined);
    const anomalyWarns = () => warn.mock.calls.filter(c => String(c[0]).includes('anomali tespiti'));

    for (let i = 0; i < m.ANOMALY_MIN_SHORT_HITS * 5; i++) m._bumpAnomalyCounter();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(anomalyWarns()).toHaveLength(1);
    // Uyari MUTLAK sayilari tasir; yuvarlanmis "0.00/sn" DEGIL.
    expect(String(anomalyWarns()[0][0])).toMatch(/son 5 dk: \d+ isabet/);

    // Surdugu surece her kontrolde tekrar ETMEZ (gunluk yagmuru)...
    for (let i = 0; i < m.ANOMALY_MIN_SHORT_HITS * 5; i++) m._bumpAnomalyCounter();
    await jest.advanceTimersByTimeAsync(2 * 60_000);
    expect(anomalyWarns()).toHaveLength(1);

    // ...ama BASTIRILMAZ: 5 dk sonra hala suruyorsa yeniden uyarir.
    for (let i = 0; i < m.ANOMALY_MIN_SHORT_HITS * 5; i++) m._bumpAnomalyCounter();
    await jest.advanceTimersByTimeAsync(3 * 60_000 + 30_000);
    expect(anomalyWarns().length).toBeGreaterThanOrEqual(2);

    // Isabetler kisa pencereden cikinca biter ve bu ACIKCA raporlanir.
    await jest.advanceTimersByTimeAsync(6 * 60_000);
    expect(info.mock.calls.some(c => String(c[0]).includes('anomalisi sona erdi'))).toBe(true);
  });
});
