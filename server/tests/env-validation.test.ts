// server/tests/env-validation.test.ts
// Security-sensitive environment validation: production must fail closed while
// test/development environments may surface non-fatal configuration warnings.

const ENV_KEYS = [
  'NODE_ENV', 'JWT_SECRET', 'REFRESH_SECRET', 'DATABASE_URL', 'PORT', 'PG_POOL_MAX',
  'MAX_FILE_SIZE_MB', 'MAX_CHANNELS_PER_SERVER', 'MAX_SERVERS_PER_USER', 'CHUNK_SIZE_MB',
  'RL_REGISTER_MAX', 'RL_REGISTER_WIN', 'RL_LOGIN_MAX', 'RL_LOGIN_WIN',
  'WEBAUTHN_RP_ID', 'WEBAUTHN_ORIGIN', 'ALLOWED_ORIGINS',
  'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS',
  'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'LOG_LEVEL', 'REDIS_URL',
  'AP_ENCRYPTION_KEY', 'FEDERATION_SECRET', 'METRICS_SECRET',
  'MAX_WS_PER_IP', 'MAX_UNAUTH_WS_PER_IP', 'MAX_WS_PER_USER',
  'AP_INBOX_GLOBAL_MAX', 'AP_INBOX_PEER_MAX', 'AP_INBOX_BURST_MAX',
  'TRUSTED_PROXY_COUNT',
  'BASE_URL', 'OIDC_ENABLED', 'OIDC_ISSUER', 'OIDC_CLIENT_ID',
  'SAML_ENABLED', 'SAML_ENTRY_POINT', 'SAML_IDP_CERT', 'SAML_IDP_ENTITY_ID',
] as const;

const ORIGINAL = new Map<string, string | undefined>(
  ENV_KEYS.map((key) => [key, process.env[key]])
);

function restoreTrackedEnv(): void {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function setTrackedEnv(values: Record<string, string | undefined>): void {
  // Start from a deterministic test baseline so one scenario cannot leak into another.
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV = 'test';
  process.env.JWT_SECRET = 'test-jwt-secret-key-do-not-use-in-production';
  process.env.REFRESH_SECRET = 'test-refresh-secret-key-do-not-use-in-production-32chars';

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function loadEnv(values: Record<string, string | undefined> = {}) {
  setTrackedEnv(values);
  jest.resetModules();
  let loaded: typeof import('../lib/env') | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    loaded = require('../lib/env');
  });
  return loaded!;
}

function validProductionEnv(): Record<string, string> {
  return {
    NODE_ENV: 'production',
    JWT_SECRET: 'j'.repeat(40),
    REFRESH_SECRET: 'r'.repeat(40),
    DATABASE_URL: 'postgresql://bridge:secret@127.0.0.1:5432/bridge',
    REDIS_URL: 'redis://127.0.0.1:6379',
    AP_ENCRYPTION_KEY: 'a'.repeat(64),
    FEDERATION_SECRET: 'f'.repeat(40),
    METRICS_SECRET: 'm'.repeat(24),
    TRUSTED_PROXY_COUNT: '1',
  };
}

describe('lib/env fail-closed validation', () => {
  let exitSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    restoreTrackedEnv();
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('accepts a fully valid production security configuration', () => {
    const result = loadEnv(validProductionEnv());

    expect(result.validated).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('fails closed in production when mandatory security/infra settings are absent', () => {
    expect(() => loadEnv({
      NODE_ENV: 'production',
      JWT_SECRET: undefined,
      REFRESH_SECRET: undefined,
      DATABASE_URL: undefined,
      REDIS_URL: undefined,
      AP_ENCRYPTION_KEY: undefined,
      FEDERATION_SECRET: undefined,
      METRICS_SECRET: undefined,
      TRUSTED_PROXY_COUNT: undefined,
    })).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    const emitted = errorSpy.mock.calls.flat().join('\n');
    expect(emitted).toContain('JWT_SECRET');
    expect(emitted).toContain('REFRESH_SECRET');
    expect(emitted).toContain('DATABASE_URL');
    expect(emitted).toContain('REDIS_URL');
    expect(emitted).toContain('AP_ENCRYPTION_KEY');
    expect(emitted).toContain('FEDERATION_SECRET');
    expect(emitted).toContain('METRICS_SECRET');
  });

  it('rejects malformed numeric, URL-like and enum settings without weakening test-mode startup', () => {
    const result = loadEnv({
      NODE_ENV: 'test',
      // Short secrets are intentionally tolerated only in tests.
      JWT_SECRET: 'short',
      REFRESH_SECRET: 'tiny',
      DATABASE_URL: 'mysql://not-postgres',
      PORT: '0',
      PG_POOL_MAX: '101',
      MAX_FILE_SIZE_MB: 'not-a-number',
      MAX_CHANNELS_PER_SERVER: '0',
      MAX_SERVERS_PER_USER: '1001',
      CHUNK_SIZE_MB: '0',
      RL_REGISTER_MAX: '0',
      RL_REGISTER_WIN: '999',
      RL_LOGIN_MAX: '0',
      RL_LOGIN_WIN: '999',
      MAX_WS_PER_IP: '1001',
      MAX_UNAUTH_WS_PER_IP: '101',
      MAX_WS_PER_USER: '101',
      AP_INBOX_GLOBAL_MAX: '100001',
      AP_INBOX_PEER_MAX: '10001',
      AP_INBOX_BURST_MAX: '1001',
      LOG_LEVEL: 'verbose',
      ALLOWED_ORIGINS: 'https://bridge.test,not a url',
    });

    expect(result.validated).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
    const warnings = warnSpy.mock.calls.flat().join('\n');
    expect(warnings).toContain('DATABASE_URL');
    expect(warnings).toContain('PORT');
    expect(warnings).toContain('PG_POOL_MAX');
    expect(warnings).toContain('MAX_FILE_SIZE_MB');
    expect(warnings).toContain('LOG_LEVEL');
    expect(warnings).toContain('ALLOWED_ORIGINS');
  });

  it('rejects partial, fractional, signed and unsafe integer environment values', () => {
    const result = loadEnv({
      NODE_ENV: 'test',
      PORT: '3001junk',
      PG_POOL_MAX: '2.5',
      RL_REGISTER_MAX: '+5',
      RL_LOGIN_MAX: String(Number.MAX_SAFE_INTEGER + 1),
    });
    expect(result.validated).toBe(true);
    const warnings = warnSpy.mock.calls.flat().join('\n');
    expect(warnings).toContain('PORT');
    expect(warnings).toContain('PG_POOL_MAX');
    expect(warnings).toContain('RL_REGISTER_MAX');
    expect(warnings).toContain('RL_LOGIN_MAX');
  });

  it('validates WebAuthn origin binding and provider credential pairs', () => {
    const result = loadEnv({
      NODE_ENV: 'development',
      WEBAUTHN_RP_ID: 'bridge.example.com',
      WEBAUTHN_ORIGIN: 'https://evil.example.net',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: undefined,
      SMTP_PASS: undefined,
      VAPID_PUBLIC_KEY: 'public-only',
      VAPID_PRIVATE_KEY: undefined,
    });

    expect(result.validated).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
    const warnings = warnSpy.mock.calls.flat().join('\n');
    expect(warnings).toContain('WEBAUTHN_ORIGIN');
    expect(warnings).toContain('SMTP');
    expect(warnings).toContain('VAPID');
  });

  it('rejects syntactically invalid WebAuthn origin in non-production with a visible warning', () => {
    const result = loadEnv({
      NODE_ENV: 'development',
      WEBAUTHN_RP_ID: 'bridge.example.com',
      WEBAUTHN_ORIGIN: 'not a url',
    });

    expect(result.validated).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(warnSpy.mock.calls.flat().join('\n')).toContain('WEBAUTHN_ORIGIN');
  });

  it('accepts matched optional provider pairs and valid bounded integer settings', () => {
    const result = loadEnv({
      NODE_ENV: 'test',
      WEBAUTHN_RP_ID: 'bridge.example.com',
      WEBAUTHN_ORIGIN: 'https://app.bridge.example.com',
      ALLOWED_ORIGINS: 'https://bridge.example.com,https://app.bridge.example.com',
      SMTP_HOST: 'smtp.example.com',
      SMTP_USER: 'bridge',
      SMTP_PASS: 'secret',
      VAPID_PUBLIC_KEY: 'public',
      VAPID_PRIVATE_KEY: 'private',
      LOG_LEVEL: 'info',
      PORT: '3001',
      PG_POOL_MAX: '20',
      MAX_FILE_SIZE_MB: '100',
      MAX_CHANNELS_PER_SERVER: '500',
      MAX_SERVERS_PER_USER: '100',
      CHUNK_SIZE_MB: '8',
      RL_REGISTER_MAX: '5',
      RL_REGISTER_WIN: '60000',
      RL_LOGIN_MAX: '10',
      RL_LOGIN_WIN: '60000',
      MAX_WS_PER_IP: '50',
      MAX_UNAUTH_WS_PER_IP: '10',
      MAX_WS_PER_USER: '10',
      AP_INBOX_GLOBAL_MAX: '10000',
      AP_INBOX_PEER_MAX: '1000',
      AP_INBOX_BURST_MAX: '100',
    });

    expect(result.validated).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('fails fast when an enabled production SSO protocol is incomplete or uses non-HTTPS public endpoints', () => {
    const prod = validProductionEnv();
    expect(() => loadEnv({
      ...prod,
      BASE_URL: 'http://localhost:3001',
      OIDC_ENABLED: 'true',
      OIDC_ISSUER: 'https://idp.example.com',
      OIDC_CLIENT_ID: undefined,
    })).toThrow('process.exit called');

    const emitted = errorSpy.mock.calls.flat().join('\n');
    expect(emitted).toContain('SSO');
    expect(emitted).toContain('BASE_URL');
    expect(emitted).toContain('OIDC_CLIENT_ID');
  });

  it('accepts a complete HTTPS production SSO configuration', () => {
    const result = loadEnv({
      ...validProductionEnv(),
      BASE_URL: 'https://bridge.example.com',
      OIDC_ENABLED: 'true',
      OIDC_ISSUER: 'https://idp.example.com',
      OIDC_CLIENT_ID: 'bridge-client',
      SAML_ENABLED: 'true',
      SAML_ENTRY_POINT: 'https://saml.example.com/login',
      SAML_IDP_CERT: 'certificate-material',
      SAML_IDP_ENTITY_ID: 'https://saml.example.com/entity',
    });
    expect(result.validated).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects malformed production security values even when all keys are present', () => {
    const prod = validProductionEnv();
    expect(() => loadEnv({
      ...prod,
      JWT_SECRET: 'too-short',
      REFRESH_SECRET: 'also-short',
      DATABASE_URL: 'https://not-postgres.example',
      AP_ENCRYPTION_KEY: 'not-hex',
      FEDERATION_SECRET: 'short',
      METRICS_SECRET: 'short',
      REDIS_URL: '   ',
    })).toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
