// server/tests/vault-aws-secrets-manager.test.ts
//
// VAULT_BACKEND=aws reads each secret with a SigV4-signed GetSecretValue
// call to AWS Secrets Manager. These tests drive the real signer (credentials
// from the environment) and a fetch double, and pin:
//   · the request goes only to a credential-free HTTPS Secrets Manager origin;
//   · the secret is taken from the right field of SecretString;
//   · "not found" is null, any other failure is an error whose text never
//     echoes the AWS response body, and production does not silently fall
//     back to a local env value.
process.env.NODE_ENV = 'test';

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), fatal: jest.fn(), error: jest.fn() },
}));

import { getSecret, _clearVaultCache } from '../lib/vault';

const mockFetch = jest.fn();
(global as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

const ENV_KEYS = ['VAULT_BACKEND', 'AWS_REGION', 'AWS_SECRET_PREFIX', 'AWS_SECRETS_MANAGER_ENDPOINT',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'VAULT_ALLOW_ENV_FALLBACK', 'NODE_ENV'];
const saved: Record<string, string | undefined> = {};
beforeAll(() => { for (const k of ENV_KEYS) saved[k] = process.env[k]; });
afterAll(() => { for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

beforeEach(() => {
  mockFetch.mockReset();
  process.env.NODE_ENV = 'test';
  process.env.VAULT_BACKEND = 'aws';
  process.env.AWS_REGION = 'eu-central-1';
  process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLETEST0000';
  process.env.AWS_SECRET_ACCESS_KEY = 'test-secret-access-key-not-real';
  delete process.env.AWS_SESSION_TOKEN;
  delete process.env.AWS_SECRET_PREFIX;
  delete process.env.AWS_SECRETS_MANAGER_ENDPOINT;
  delete process.env.VAULT_ALLOW_ENV_FALLBACK;
  _clearVaultCache();
});

function answer(status: number, body: unknown) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
}

describe('AWS Secrets Manager — the signed request', () => {
  it('is a SigV4 GetSecretValue POST to the regional endpoint for the prefixed secret id', async () => {
    answer(200, { SecretString: 'plain-value' });
    await expect(getSecret('AWS_PLAIN_KEY')).resolves.toBe('plain-value');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(String(url)).toBe('https://secretsmanager.eu-central-1.amazonaws.com/');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ SecretId: 'bridge/AWS_PLAIN_KEY' });
    expect(init.headers['x-amz-target']).toBe('secretsmanager.GetSecretValue');
    expect(init.headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLETEST0000\/\d{8}\/eu-central-1\/secretsmanager\/aws4_request, SignedHeaders=[^,]*host[^,]*, Signature=[0-9a-f]{64}$/);
  });

  it('uses the configured prefix, and the China partition domain for cn- regions', async () => {
    process.env.AWS_REGION = 'cn-north-1';
    process.env.AWS_SECRET_PREFIX = 'prod/bridge/';
    answer(200, { SecretString: 'cn-value' });
    await expect(getSecret('AWS_CN_KEY')).resolves.toBe('cn-value');
    const [url, init] = mockFetch.mock.calls[0]!;
    expect(String(url)).toBe('https://secretsmanager.cn-north-1.amazonaws.com.cn/');
    expect(JSON.parse(init.body)).toEqual({ SecretId: 'prod/bridge/AWS_CN_KEY' });
  });

  it.each([
    ['plain HTTP', 'http://localstack.test:4566'],
    ['embedded credentials', 'https://user:pass@secrets.test'],
    ['a path', 'https://secrets.test/proxy'],
    ['a query string', 'https://secrets.test/?redirect=evil'],
  ])('an endpoint override with %s is refused before anything is signed or sent', async (_name, endpoint) => {
    process.env.AWS_SECRETS_MANAGER_ENDPOINT = endpoint;
    process.env.NODE_ENV = 'production';
    _clearVaultCache();
    await expect(getSecret('AWS_OVERRIDE_KEY')).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('a credential-free HTTPS override origin is used as given', async () => {
    process.env.AWS_SECRETS_MANAGER_ENDPOINT = 'https://vpce-1234.secretsmanager.eu-central-1.vpce.amazonaws.com';
    answer(200, { SecretString: 'via-endpoint' });
    await expect(getSecret('AWS_ENDPOINT_KEY')).resolves.toBe('via-endpoint');
    expect(String(mockFetch.mock.calls[0]![0])).toBe('https://vpce-1234.secretsmanager.eu-central-1.vpce.amazonaws.com/');
  });
});

describe('AWS Secrets Manager — reading the answer', () => {
  it.each([
    ['a JSON object keyed by the secret name', { AWS_JSON_KEY: 'named-value', other: 'x' }, 'named-value'],
    ['a JSON object with a generic `value`', { value: 'generic-value' }, 'generic-value'],
    ['a JSON scalar, kept as the string it was stored as', 12345, '12345'],
  ])('%s', async (_name, stored, expected) => {
    answer(200, { SecretString: JSON.stringify(stored) });
    await expect(getSecret('AWS_JSON_KEY')).resolves.toBe(expected);
  });

  it('a secret with no SecretString (binary or empty) is absent, not an empty string', async () => {
    answer(200, { SecretBinary: 'AAEC' });
    await expect(getSecret('AWS_BINARY_KEY')).resolves.toBeNull();
    answer(200, { SecretString: '' });
    await expect(getSecret('AWS_EMPTY_KEY')).resolves.toBeNull();
  });

  it('a 404 or ResourceNotFoundException is a clean "not found" (null), not an error', async () => {
    const logger = require('../lib/logger').default as { warn: jest.Mock };
    const errorEvents = () => logger.warn.mock.calls.filter((c) => c[0]?.event === 'vault.get_secret.error').length;
    logger.warn.mockClear();
    answer(404, '');
    await expect(getSecret('AWS_GONE_KEY')).resolves.toBeNull();
    answer(400, { __type: 'com.amazonaws.secretsmanager#ResourceNotFoundException', message: 'gone' });
    await expect(getSecret('AWS_GONE_KEY_2')).resolves.toBeNull();
    expect(errorEvents()).toBe(0);
    // Control: a genuine failure of the same shape IS reported as an error.
    answer(400, { __type: 'ThrottlingException', message: 'slow down' });
    await expect(getSecret('AWS_GONE_KEY_3')).resolves.toBeNull();
    expect(errorEvents()).toBe(1);
  });

  it('any other failure is fail-closed in production and never consults the local env value', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AWS_DENIED_KEY = 'stale-local-copy';
    _clearVaultCache();
    answer(400, { __type: 'AccessDeniedException', message: 'arn:aws:iam::123456789012:role/secret-reader is not authorized' });
    await expect(getSecret('AWS_DENIED_KEY')).resolves.toBeNull();
    delete process.env.AWS_DENIED_KEY;
  });

  it('outside production the same failure may fall back to the local env value', async () => {
    process.env.AWS_DEV_KEY = 'local-dev-value';
    answer(500, 'not json');
    await expect(getSecret('AWS_DEV_KEY')).resolves.toBe('local-dev-value');
    delete process.env.AWS_DEV_KEY;
  });

  it('the failure logged for an AWS error carries the status, never the AWS response body', async () => {
    const logger = require('../lib/logger').default as { warn: jest.Mock };
    logger.warn.mockClear();
    answer(403, { __type: 'AccessDeniedException', message: 'secret-reader-role-detail' });
    await getSecret('AWS_LOG_KEY');
    const logged = JSON.stringify(logger.warn.mock.calls, (_k, v) => (v instanceof Error ? v.message : v));
    expect(logged).toContain('AWS Secrets Manager request failed (403)');
    expect(logged).not.toContain('secret-reader-role-detail');
  });
});

describe('secret names', () => {
  it.each([['lower case', 'aws_key'], ['a path', 'A/../B'], ['empty', ''], ['too long', `A${'B'.repeat(128)}`]])(
    'a name with %s is refused before any backend is asked', async (_name, secretName) => {
      await expect(getSecret(secretName)).rejects.toThrow('[vault] Invalid secret name');
      expect(mockFetch).not.toHaveBeenCalled();
    });
});
