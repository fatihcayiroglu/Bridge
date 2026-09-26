/*
 * Behavior-level coverage for operational/security owners that previously had
 * little or no direct coverage.  These tests intentionally validate public
 * contracts rather than implementation-only constants.
 */

describe('lib/telemetry lifecycle', () => {
  const savedEnv = { ...process.env };
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), fatal: jest.fn() };

  afterAll(() => { process.env = savedEnv; });

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env = { ...savedEnv, NODE_ENV: 'test' };
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete process.env.SENTRY_DSN;
    delete process.env.OTEL_ENABLED;
    jest.doMock('../lib/logger', () => ({ __esModule: true, default: log }));
  });

  test('disabled telemetry imports cleanly and announceSpan is a no-op', async () => {
    const tryRequire = jest.fn();
    jest.doMock('../lib/_optional-require', () => ({ tryRequire }));
    const telemetry = require('../lib/telemetry');
    const span = telemetry.announceSpan('disabled', { a: 'b' });
    expect(() => span.end()).not.toThrow();
    expect(tryRequire).not.toHaveBeenCalled();
    await expect(telemetry.shutdownTelemetry()).resolves.toBeUndefined();
    expect(log.info).toHaveBeenCalled();
  });

  test('configured OTel with a missing optional package disables tracing safely', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel.test/v1/traces';
    jest.doMock('../lib/_optional-require', () => ({ tryRequire: jest.fn(() => null) }));
    expect(() => require('../lib/telemetry')).not.toThrow();
    expect(log.warn).toHaveBeenCalledWith(expect.objectContaining({ otel: false }), expect.any(String));
  });

  test('starts OTel/Sentry, emits spans and shuts the SDK down', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel.test/v1/traces';
    process.env.OTEL_EXPORTER_OTLP_HEADERS = 'Authorization=token, X-Tenant=bridge';
    process.env.OTEL_SERVICE_NAME = 'bridge-test';
    process.env.SENTRY_DSN = 'https://public@example.test/3';

    const span = { setAttributes: jest.fn(), end: jest.fn() };
    const sdk = { start: jest.fn(), shutdown: jest.fn().mockResolvedValue(undefined) };
    const NodeSDK = jest.fn(() => sdk);
    const OTLPTraceExporter = jest.fn(() => ({ exporter: true }));
    const Resource = jest.fn(() => ({ resource: true }));
    const getNodeAutoInstrumentations = jest.fn(() => ['auto']);
    const sentry = { init: jest.fn(), captureException: jest.fn() };
    const api = { trace: { getTracer: jest.fn(() => ({ startSpan: jest.fn(() => span) })) } };
    const modules: Record<string, unknown> = {
      '@opentelemetry/sdk-node': { NodeSDK },
      '@opentelemetry/exporter-trace-otlp-http': { OTLPTraceExporter },
      '@opentelemetry/resources': { Resource },
      '@opentelemetry/semantic-conventions': {
        SEMRESATTRS_SERVICE_NAME: 'service.name',
        SEMRESATTRS_SERVICE_VERSION: 'service.version',
      },
      '@opentelemetry/auto-instrumentations-node': { getNodeAutoInstrumentations },
      '@opentelemetry/api': api,
      '@sentry/node': sentry,
    };
    jest.doMock('../lib/_optional-require', () => ({
      tryRequire: jest.fn((name: string) => modules[name] ?? null),
    }));

    const telemetry = require('../lib/telemetry');
    expect(NodeSDK).toHaveBeenCalledTimes(1);
    expect(sdk.start).toHaveBeenCalledTimes(1);
    expect(OTLPTraceExporter).toHaveBeenCalledWith(expect.objectContaining({
      url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
      headers: { Authorization: 'token', 'X-Tenant': 'bridge' },
    }));
    expect(sentry.init).toHaveBeenCalledWith(expect.objectContaining({ dsn: process.env.SENTRY_DSN }));

    const created = telemetry.announceSpan('db.query', { 'db.system': 'postgresql' });
    expect(span.setAttributes).toHaveBeenCalledWith({ 'db.system': 'postgresql' });
    created.end();
    expect(span.end).toHaveBeenCalledTimes(1);
    await telemetry.shutdownTelemetry();
    expect(sdk.shutdown).toHaveBeenCalledTimes(1);
  });

  test('SDK init, span creation, Sentry init and shutdown errors are contained', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://otel.test/v1/traces';
    process.env.SENTRY_DSN = 'https://public@example.test/4';
    const sdk = { start: jest.fn(() => { throw new Error('start'); }), shutdown: jest.fn().mockRejectedValue(new Error('stop')) };
    const modules: Record<string, any> = {
      '@opentelemetry/sdk-node': { NodeSDK: jest.fn(() => sdk) },
      '@opentelemetry/exporter-trace-otlp-http': { OTLPTraceExporter: jest.fn(() => ({})) },
      '@opentelemetry/resources': { Resource: jest.fn(() => ({})) },
      '@opentelemetry/semantic-conventions': { SEMRESATTRS_SERVICE_NAME: 'name', SEMRESATTRS_SERVICE_VERSION: 'version' },
      '@opentelemetry/auto-instrumentations-node': { getNodeAutoInstrumentations: jest.fn(() => []) },
      '@opentelemetry/api': { trace: { getTracer: jest.fn(() => { throw new Error('span'); }) } },
      '@sentry/node': { init: jest.fn(() => { throw new Error('sentry'); }), captureException: jest.fn() },
    };
    jest.doMock('../lib/_optional-require', () => ({ tryRequire: jest.fn((name: string) => modules[name] ?? null) }));
    const telemetry = require('../lib/telemetry');
    expect(() => telemetry.announceSpan('broken')).not.toThrow();
    await expect(telemetry.shutdownTelemetry()).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('middleware/botAuth', () => {
  beforeEach(() => { jest.resetModules(); jest.clearAllMocks(); });

  function load(findByTokenHash: jest.Mock) {
    jest.doMock('../db/repositories', () => ({ Bots: { findByTokenHash } }));
    return require('../middleware/botAuth');
  }

  test('rejects malformed tokens before database lookup', async () => {
    const find = jest.fn();
    const auth = load(find);
    for (const token of [null, 42, '', 'Bearer x', 'brg_bot_short', `brg_bot_${'x'.repeat(300)}`]) {
      await expect(auth.resolveBotToken(token)).resolves.toBeNull();
    }
    expect(find).not.toHaveBeenCalled();
  });

  test('hashes opaque token and only accepts a complete active identity', async () => {
    const good = { _id: 'b1', serverId: 's1', username: 'bot', active: true };
    const find = jest.fn().mockResolvedValueOnce(good).mockResolvedValueOnce({ ...good, active: false });
    const auth = load(find);
    const token = `brg_bot_${'a'.repeat(32)}`;
    await expect(auth.resolveBotToken(token)).resolves.toEqual(good);
    expect(find).toHaveBeenCalledWith(expect.stringMatching(/^[0-9a-f]{64}$/));
    await expect(auth.resolveBotToken(token)).resolves.toBeNull();
  });

  test('extracts only Bot authorization and trims the opaque token', () => {
    const auth = load(jest.fn());
    expect(auth.extractBotAuthorization({ headers: {} } as any)).toBeNull();
    expect(auth.extractBotAuthorization({ headers: { authorization: 'Bearer token' } } as any)).toBeNull();
    expect(auth.extractBotAuthorization({ headers: { authorization: 'Bot    ' } } as any)).toBeNull();
    expect(auth.extractBotAuthorization({ headers: { authorization: 'Bot brg_bot_abc' } } as any)).toBe('brg_bot_abc');
  });

  test('middleware distinguishes missing, invalid, valid and unavailable authorization', async () => {
    const good = { _id: 'b1', serverId: 's1', username: 'bot', active: true };
    const find = jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(good).mockRejectedValueOnce(new Error('db'));
    const auth = load(find);
    const res = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

    let response = res(); let next = jest.fn();
    await auth.botAuthMiddleware({ headers: {} } as any, response as any, next);
    expect(response.status).toHaveBeenCalledWith(401); expect(next).not.toHaveBeenCalled();

    response = res(); next = jest.fn();
    await auth.botAuthMiddleware({ headers: { authorization: `Bot brg_bot_${'a'.repeat(32)}` } } as any, response as any, next);
    expect(response.status).toHaveBeenCalledWith(401);

    const req: any = { headers: { authorization: `Bot brg_bot_${'b'.repeat(32)}` } };
    response = res(); next = jest.fn();
    await auth.botAuthMiddleware(req, response as any, next);
    expect(next).toHaveBeenCalledTimes(1); expect(req.bot).toEqual(good);

    response = res(); next = jest.fn();
    await auth.botAuthMiddleware({ headers: { authorization: `Bot brg_bot_${'c'.repeat(32)}` } } as any, response as any, next);
    expect(response.status).toHaveBeenCalledWith(503); expect(next).not.toHaveBeenCalled();
  });
});

describe('lib/automodRuntime', () => {
  const Channels = { findByIdAndServer: jest.fn() };
  const Messages = { create: jest.fn() };
  const logger = { warn: jest.fn() };

  beforeEach(() => {
    jest.resetModules(); jest.clearAllMocks();
    jest.doMock('../db/repositories', () => ({ Channels, Messages }));
    jest.doMock('../lib/logger', () => ({ __esModule: true, default: logger, createLogger: jest.fn(() => logger) }));
  });

  test('normalizes persisted member role IDs defensively', () => {
    const runtime = require('../lib/automodRuntime');
    expect(runtime.normalizeAutomodMemberRoleIds(null)).toEqual([]);
    expect(runtime.normalizeAutomodMemberRoleIds('{bad')).toEqual([]);
    expect(runtime.normalizeAutomodMemberRoleIds('not-an-array')).toEqual([]);
    expect(runtime.normalizeAutomodMemberRoleIds('["r1","r1",2,"r2",""]')).toEqual(['r1', 'r2']);
  });

  test('skips unmatched/no-log decisions and ignores invalid tenant/type log channels', async () => {
    const runtime = require('../lib/automodRuntime');
    const io = { to: jest.fn(() => ({ emit: jest.fn() })) };
    const context = { serverId: 's1', channelId: 'c1', userId: 'u1', displayName: 'User', content: 'hello' };
    await runtime.writeAutomodLogs({ matched: false, logChannelIds: [] } as any, context, io as any);
    expect(Channels.findByIdAndServer).not.toHaveBeenCalled();

    Channels.findByIdAndServer.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'log', type: 'voice' });
    const decision = { matched: true, logChannelIds: ['gone', 'voice'], reasons: ['word'], deleteMessage: false, timeoutMs: 0 };
    await runtime.writeAutomodLogs(decision as any, context, io as any);
    expect(Messages.create).not.toHaveBeenCalled();
  });

  test('writes tenant-scoped sanitized audit messages and broadcasts them', async () => {
    const runtime = require('../lib/automodRuntime');
    Channels.findByIdAndServer.mockResolvedValue({ _id: 'log', type: 'announcement' });
    Messages.create.mockImplementation(async (row: any) => ({ ...row, persisted: true }));
    const emit = jest.fn(); const io = { to: jest.fn(() => ({ emit })) };
    const decision = {
      matched: true, logChannelIds: ['log'], reasons: ['blocked_words'], deleteMessage: true,
      timeoutMs: 61_000,
    };
    await runtime.writeAutomodLogs(decision as any, {
      serverId: 's1', channelId: 'c1', userId: 'u1', displayName: 'User',
      content: '<script>alert(1)</script>`secret`', operation: 'edit',
    }, io as any);
    expect(Channels.findByIdAndServer).toHaveBeenCalledWith('log', 's1');
    expect(Messages.create).toHaveBeenCalledWith(expect.objectContaining({
      channelId: 'log', serverId: 's1', userId: 'system', autoModAlert: true,
      content: expect.stringContaining('düzenleme engellendi'),
    }));
    expect(io.to).toHaveBeenCalledWith('channel:log');
    expect(emit).toHaveBeenCalledWith('message:new', expect.objectContaining({ persisted: true }));
  });

  test('audit persistence failure is isolated from the moderation decision', async () => {
    const runtime = require('../lib/automodRuntime');
    Channels.findByIdAndServer.mockResolvedValue({ _id: 'log', type: 'text' });
    Messages.create.mockRejectedValue(new Error('db'));
    await expect(runtime.writeAutomodLogs({
      matched: true, logChannelIds: ['log'], reasons: [], deleteMessage: false, timeoutMs: 0,
    } as any, {
      serverId: 's1', channelId: 'c1', userId: 'u1', displayName: 'User', content: 'x',
    }, { to: jest.fn() } as any)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
