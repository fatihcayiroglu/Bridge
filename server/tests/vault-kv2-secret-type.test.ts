// server/tests/vault-kv2-secret-type.test.ts
//
// KV v2 payloads come from JSON. A TypeScript assertion is not a runtime
// validator: only a string is an acceptable secret or cache entry.
process.env.NODE_ENV = 'test';

jest.mock('../lib/logger', () => ({
  default: { info: jest.fn(), warn: jest.fn(), fatal: jest.fn(), error: jest.fn() },
}));

import { getSecret, _clearVaultCache } from '../lib/vault';

const mockFetch = jest.fn();
(global as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;
const ENV_KEYS = ['VAULT_BACKEND', 'VAULT_ADDR', 'VAULT_TOKEN', 'VAULT_ALLOW_ENV_FALLBACK', 'A_SECRET'];

function kv(value: unknown): void {
  mockFetch.mockResolvedValueOnce({
    ok: true, status: 200,
    json: async () => ({ data: { data: { A_SECRET: value, UNRELATED_SECRET: 'not-for-this-reader' } } }),
  });
}

beforeEach(() => {
  _clearVaultCache();
  mockFetch.mockReset();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV = 'production';
  process.env.VAULT_BACKEND = 'hashicorp';
  process.env.VAULT_ADDR = 'https://vault.test';
  process.env.VAULT_TOKEN = 'static-token';
  process.env.VAULT_ALLOW_ENV_FALLBACK = 'false';
});

afterEach(() => {
  _clearVaultCache();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV = 'test';
});

describe('HashiCorp KV v2 return-value type boundary', () => {
  it.each([
    ['object', { token: 'sensitive-nested-value' }],
    ['array', ['sensitive-nested-value']],
    ['number', 12345],
    ['boolean', true],
    ['null', null],
  ])('refuses %s as a secret instead of exposing a non-string value', async (_case, value) => {
    process.env.A_SECRET = 'stale-local-secret';
    kv(value);
    await expect(getSecret('A_SECRET')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('does not cache a rejected value and accepts a corrected string on the next read', async () => {
    kv({ embedded: 'not-a-string' });
    await expect(getSecret('A_SECRET')).resolves.toBeNull();
    kv('rotated-string-secret');
    await expect(getSecret('A_SECRET')).resolves.toBe('rotated-string-secret');
    await expect(getSecret('A_SECRET')).resolves.toBe('rotated-string-secret');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('does not substitute a sibling value for a missing named secret', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ data: { data: { UNRELATED_SECRET: 'sensitive-other-credential' } } }),
    });
    await expect(getSecret('A_SECRET')).resolves.toBeNull();
  });

  it('does not treat a malformed KV v2 envelope as a secret', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => null });
    await expect(getSecret('A_SECRET')).resolves.toBeNull();
  });
});
