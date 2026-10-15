// server/tests/vault-address-and-cache-expiry.test.ts
//
// lib/vault: three operator-facing guarantees that had no test.
//
// 1. VAULT_ADDR must be a bare origin. An address that carries credentials,
//    a query or a fragment, or that is not HTTP(S), is refused BEFORE any
//    request is sent. In production the read then fails closed; the password
//    in such an address never reaches a log line.
// 2. Cached secrets expire. A secret is cached for 5 minutes; after that the
//    next read goes back to Vault, so a rotated secret is picked up. (The
//    token-lifecycle suite describes this but never let the clock pass.)
// 3. Missing required secrets stop a production process (exit code 1); in
//    development they only warn.
process.env.NODE_ENV = 'test';

const vaultLogger = { info: jest.fn(), warn: jest.fn(), fatal: jest.fn(), error: jest.fn() };
jest.mock('../lib/logger', () => ({ default: vaultLogger }));

import { getSecret, validateRequiredSecrets, _clearVaultCache } from '../lib/vault';

const mockFetch = jest.fn();
(global as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

const KEYS = ['VAULT_BACKEND', 'VAULT_ADDR', 'VAULT_TOKEN', 'VAULT_ROLE_ID', 'VAULT_SECRET_ID', 'VAULT_ALLOW_ENV_FALLBACK', 'A_SECRET', 'B_SECRET'];
const allLogged = () => JSON.stringify(Object.values(vaultLogger).flatMap(fn => fn.mock.calls), (_k, v) => (v instanceof Error ? v.message : v));

function kvRead(value: string, key = 'A_SECRET') {
  mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ data: { data: { [key]: value } } }), text: async () => '' });
}

beforeEach(() => {
  _clearVaultCache();
  mockFetch.mockReset();
  for (const fn of Object.values(vaultLogger)) fn.mockClear();
  for (const key of KEYS) delete process.env[key];
  process.env.NODE_ENV = 'test';
});
afterEach(() => {
  for (const key of KEYS) delete process.env[key];
  process.env.NODE_ENV = 'test';
  jest.restoreAllMocks();
});

describe('VAULT_ADDR must be a bare HTTP(S) origin', () => {
  it.each([
    ['a user name and password', 'https://ops:s3cret-pass@vault.test'],
    ['a user name only', 'https://ops@vault.test'],
    ['a query string', 'https://vault.test/?token=s3cret-pass'],
    ['a fragment', 'https://vault.test/#s3cret-pass'],
  ])('an address with %s is refused before any request; production fails closed and logs no secret', async (_label, addr) => {
    process.env.NODE_ENV = 'production';
    process.env.VAULT_BACKEND = 'hashicorp';
    process.env.VAULT_ADDR = addr;
    process.env.VAULT_TOKEN = 'static-token';
    process.env.A_SECRET = 'local-env-value';

    await expect(getSecret('A_SECRET')).resolves.toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(vaultLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'vault.get_secret.error', err: expect.objectContaining({ message: '[vault] VAULT_ADDR must be a credential-free origin URL.' }) }),
      expect.any(String),
    );
    expect(allLogged()).not.toContain('s3cret-pass');
    expect(allLogged()).not.toContain('static-token');
  });

  it('a non-HTTP(S) address is refused before any request (outside production the local env value is used)', async () => {
    process.env.NODE_ENV = 'development';
    process.env.VAULT_BACKEND = 'hashicorp';
    process.env.VAULT_ADDR = 'ftp://vault.test';
    process.env.VAULT_TOKEN = 'static-token';
    process.env.A_SECRET = 'local-env-value';

    await expect(getSecret('A_SECRET')).resolves.toBe('local-env-value');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(vaultLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.objectContaining({ message: '[vault] VAULT_ADDR must use HTTP(S).' }) }),
      expect.any(String),
    );
  });

  it('a bare origin with a path prefix is accepted and used', async () => {
    process.env.VAULT_BACKEND = 'hashicorp';
    process.env.VAULT_ADDR = 'https://vault.test/ns/';
    process.env.VAULT_TOKEN = 'static-token';
    kvRead('from-vault');
    await expect(getSecret('A_SECRET')).resolves.toBe('from-vault');
    expect(String(mockFetch.mock.calls[0]![0])).toBe('https://vault.test/ns/v1/secret/data/bridge/A_SECRET');
  });
});

describe('cached secrets expire after 5 minutes', () => {
  it('a read within 5 minutes is served from cache; after that Vault is asked again and a rotated value is returned', async () => {
    process.env.VAULT_BACKEND = 'hashicorp';
    process.env.VAULT_ADDR = 'https://vault.test';
    process.env.VAULT_TOKEN = 'static-token';
    const t0 = 1_790_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(t0);

    kvRead('first');
    await expect(getSecret('A_SECRET')).resolves.toBe('first');
    clock.mockReturnValue(t0 + 5 * 60_000);          // exactly at the TTL: still cached
    await expect(getSecret('A_SECRET')).resolves.toBe('first');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(t0 + 5 * 60_000 + 1);      // past the TTL: dropped and re-read
    kvRead('rotated');
    await expect(getSecret('A_SECRET')).resolves.toBe('rotated');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

describe('missing required secrets', () => {
  it('stop a production process with exit code 1', async () => {
    process.env.NODE_ENV = 'production';
    process.env.A_SECRET = 'present';
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await validateRequiredSecrets(['A_SECRET', 'B_SECRET']);
    expect(exit).toHaveBeenCalledWith(1);
    expect(vaultLogger.fatal).toHaveBeenCalledWith(
      expect.objectContaining({ missing: ['B_SECRET'], event: 'vault.required_secrets_missing' }), expect.any(String));
  });

  it('do not stop a production process when every secret is present', async () => {
    process.env.NODE_ENV = 'production';
    process.env.A_SECRET = 'present';
    process.env.B_SECRET = 'present-too';
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await validateRequiredSecrets(['A_SECRET', 'B_SECRET']);
    expect(exit).not.toHaveBeenCalled();
    expect(vaultLogger.fatal).not.toHaveBeenCalled();
  });
});
