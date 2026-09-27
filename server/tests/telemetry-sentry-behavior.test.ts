process.env.NODE_ENV = 'test';

const originalEnv = { ...process.env };
const signalKey = Symbol.for('bridge.telemetry.signalHookRegistered');

type AnyObj = Record<string, any>;

function restoreEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  delete (globalThis as AnyObj)[signalKey as any];
}

describe('lib/telemetry lifecycle and optional dependency boundaries', () => {
  let processOnSpy: jest.SpyInstance;
  let logger: { info: jest.Mock; warn: jest.Mock };
  let modules: Map<string, unknown>;

  function loadTelemetry(env: Record<string, string | undefined> = {}) {
    jest.resetModules();
    restoreEnv();
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    delete (globalThis as AnyObj)[signalKey as any];
    logger = { info: jest.fn(), warn: jest.fn() };
    modules = new Map();
    jest.doMock('../lib/logger', () => ({ __esModule: true, default: logger }));
    jest.doMock('../lib/_optional-require', () => ({ tryRequire: (id: string) => modules.get(id) ?? null }));
    processOnSpy = jest.spyOn(process, 'on').mockImplementation(() => process as any);
    return () => require('../lib/telemetry') as typeof import('../lib/telemetry');
  }

  afterEach(() => {
    jest.restoreAllMocks();
    jest.resetModules();
    restoreEnv();
  });

  test('disabled telemetry is a no-op with one deduplicated signal hook pair', () => {
    const requireTelemetry = loadTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: undefined, SENTRY_DSN: undefined });
    const telemetry = requireTelemetry();
    expect(logger.info).toHaveBeenCalledWith({ otel: false }, expect.stringContaining('OTel'));
    expect(logger.info).toHaveBeenCalledWith({ sentry: false }, expect.stringContaining('Sentry'));
    expect(processOnSpy.mock.calls.filter(([s]) => s === 'SIGTERM')).toHaveLength(1);
    expect(processOnSpy.mock.calls.filter(([s]) => s === 'SIGINT')).toHaveLength(1);
    expect(telemetry.announceSpan('disabled').end()).toBeUndefined();
  });

  test('missing OTel package set disables tracing without constructing a partial SDK', () => {
    const requireTelemetry = loadTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' });
    modules.set('@opentelemetry/sdk-node', { NodeSDK: jest.fn() });
    requireTelemetry();
    expect(logger.warn).toHaveBeenCalledWith({ otel: false }, expect.stringContaining('paketleri eksik'));
  });

  test('full OTel init wires exporter headers, resource, instrumentation and starts SDK', async () => {
    const requireTelemetry = loadTelemetry({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces',
      OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Bearer test, x-tenant=bridge',
      OTEL_SERVICE_NAME: 'bridge-api', npm_package_version: '9.9.9', NODE_ENV: 'staging',
    });
    const exporterCtor = jest.fn().mockImplementation((o) => ({ exporter: o }));
    const resourceCtor = jest.fn().mockImplementation((o) => ({ resource: o }));
    const start = jest.fn(); const shutdown = jest.fn().mockResolvedValue(undefined);
    const sdkCtor = jest.fn().mockImplementation((o) => ({ start: () => start(o), shutdown }));
    const auto = jest.fn(() => ['http']);
    modules.set('@opentelemetry/sdk-node', { NodeSDK: sdkCtor });
    modules.set('@opentelemetry/exporter-trace-otlp-http', { OTLPTraceExporter: exporterCtor });
    modules.set('@opentelemetry/resources', { Resource: resourceCtor });
    modules.set('@opentelemetry/semantic-conventions', { SEMRESATTRS_SERVICE_NAME: 'service.name', SEMRESATTRS_SERVICE_VERSION: 'service.version' });
    modules.set('@opentelemetry/auto-instrumentations-node', { getNodeAutoInstrumentations: auto });
    const telemetry = requireTelemetry();
    expect(exporterCtor).toHaveBeenCalledWith({ url: 'https://otel.example/v1/traces', headers: { authorization: 'Bearer test', 'x-tenant': 'bridge' } });
    expect(resourceCtor).toHaveBeenCalledWith({ 'service.name': 'bridge-api', 'service.version': '9.9.9', 'deployment.environment': 'staging' });
    expect(auto).toHaveBeenCalledWith({ '@opentelemetry/instrumentation-fs': { enabled: false } });
    expect(start).toHaveBeenCalled();
    await expect(telemetry.shutdownTelemetry()).resolves.toBeUndefined();
    expect(shutdown).toHaveBeenCalled();
  });

  test('OTel constructor/start failure is contained and logged', () => {
    const requireTelemetry = loadTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' });
    modules.set('@opentelemetry/sdk-node', { NodeSDK: class { constructor() { throw new Error('bad sdk'); } } });
    modules.set('@opentelemetry/exporter-trace-otlp-http', { OTLPTraceExporter: class {} });
    modules.set('@opentelemetry/resources', { Resource: class {} });
    modules.set('@opentelemetry/semantic-conventions', { SEMRESATTRS_SERVICE_NAME: 'n', SEMRESATTRS_SERVICE_VERSION: 'v' });
    modules.set('@opentelemetry/auto-instrumentations-node', { getNodeAutoInstrumentations: () => [] });
    expect(() => requireTelemetry()).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('başlatma başarısız'));
  });

  test('Sentry optional package absent is logged; present package receives release and redacts request secrets', () => {
    let requireTelemetry = loadTelemetry({ SENTRY_DSN: 'https://public@example.invalid/1', OTEL_EXPORTER_OTLP_ENDPOINT: undefined });
    requireTelemetry();
    expect(logger.warn).toHaveBeenCalledWith({ sentry: false }, expect.stringContaining('@sentry/node'));

    requireTelemetry = loadTelemetry({
      SENTRY_DSN: 'https://public@example.invalid/1',
      SENTRY_RELEASE: 'bridge@explicit-release',
      OTEL_EXPORTER_OTLP_ENDPOINT: undefined,
      OTEL_SERVICE_NAME: 'bridge-worker',
      NODE_ENV: 'production',
    });
    const init = jest.fn();
    const flush = jest.fn().mockResolvedValue(true);
    modules.set('@sentry/node', { init, captureException: jest.fn(), flush });
    const telemetry = requireTelemetry();
    expect(init).toHaveBeenCalledWith(expect.objectContaining({
      dsn: process.env.SENTRY_DSN,
      environment: 'production',
      release: 'bridge@explicit-release',
      integrations: undefined,
    }));
    const opts = init.mock.calls[0][0] as { beforeSend: (event: Record<string, unknown>) => Record<string, unknown> };
    const event = {
      request: {
        cookies: { sid: 'secret' },
        headers: {
          Authorization: 'Bearer secret',
          COOKIE: 'sid=secret',
          'X-Api-Key': 'secret',
          accept: 'application/json',
        },
      },
    };
    expect(opts.beforeSend(event)).toBe(event);
    expect(event.request).not.toHaveProperty('cookies');
    expect(event.request.headers).toEqual({ accept: 'application/json' });
    return telemetry.shutdownTelemetry().then(() => expect(flush).toHaveBeenCalledWith(2_000));
  });

  test('Sentry init failure is contained', () => {
    const requireTelemetry = loadTelemetry({ SENTRY_DSN: 'https://public@example.invalid/1' });
    modules.set('@sentry/node', { init: () => { throw new Error('bad sentry config'); }, captureException: jest.fn() });
    requireTelemetry();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('Sentry başlatma başarısız'));
  });

  test('announceSpan uses API tracer when available and falls back if API is absent or throws', () => {
    let requireTelemetry = loadTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' });
    const span = { setAttributes: jest.fn(), end: jest.fn() };
    const startSpan = jest.fn(() => span);
    modules.set('@opentelemetry/sdk-node', { NodeSDK: class { start() {} async shutdown() {} } });
    modules.set('@opentelemetry/exporter-trace-otlp-http', { OTLPTraceExporter: class {} });
    modules.set('@opentelemetry/resources', { Resource: class {} });
    modules.set('@opentelemetry/semantic-conventions', { SEMRESATTRS_SERVICE_NAME: 'n', SEMRESATTRS_SERVICE_VERSION: 'v' });
    modules.set('@opentelemetry/auto-instrumentations-node', { getNodeAutoInstrumentations: () => [] });
    modules.set('@opentelemetry/api', { trace: { getTracer: () => ({ startSpan }) } });
    let telemetry = requireTelemetry();
    expect(telemetry.announceSpan('db.query', { table: 'users' })).toBe(span);
    expect(span.setAttributes).toHaveBeenCalledWith({ table: 'users' });

    modules.delete('@opentelemetry/api');
    expect(telemetry.announceSpan('missing-api').end()).toBeUndefined();
    modules.set('@opentelemetry/api', { trace: { getTracer: () => { throw new Error('api broken'); } } });
    expect(telemetry.announceSpan('broken-api').end()).toBeUndefined();
  });

  test('shutdown logs SDK failures and duplicate module loads do not multiply signal hooks', async () => {
    const requireTelemetry = loadTelemetry({ OTEL_EXPORTER_OTLP_ENDPOINT: 'https://otel.example/v1/traces' });
    const shutdown = jest.fn().mockRejectedValue(new Error('shutdown failed'));
    modules.set('@opentelemetry/sdk-node', { NodeSDK: class { start() {} shutdown() { return shutdown(); } } });
    modules.set('@opentelemetry/exporter-trace-otlp-http', { OTLPTraceExporter: class {} });
    modules.set('@opentelemetry/resources', { Resource: class {} });
    modules.set('@opentelemetry/semantic-conventions', { SEMRESATTRS_SERVICE_NAME: 'n', SEMRESATTRS_SERVICE_VERSION: 'v' });
    modules.set('@opentelemetry/auto-instrumentations-node', { getNodeAutoInstrumentations: () => [] });
    const telemetry = requireTelemetry();
    await expect(telemetry.shutdownTelemetry()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining('kapatma hatası'));

    const before = processOnSpy.mock.calls.length;
    jest.resetModules();
    jest.doMock('../lib/logger', () => ({ __esModule: true, default: logger }));
    jest.doMock('../lib/_optional-require', () => ({ tryRequire: (id: string) => modules.get(id) ?? null }));
    require('../lib/telemetry');
    expect(processOnSpy.mock.calls.length).toBe(before);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
