// server/tests/vault-provider-error-redaction.test.ts
//
// A Vault error body is controlled by the upstream service/proxy and may echo
// credentials or stored secrets. Keep HTTP status diagnostics, never that body.
process.env.NODE_ENV = 'test';

const vaultLogger = { info: jest.fn(), warn: jest.fn(), fatal: jest.fn(), error: jest.fn() };
jest.mock('../lib/logger', () => ({ default: vaultLogger }));

import { getSecret, _clearVaultCache } from '../lib/vault';

const mockFetch = jest.fn();
(global as { fetch?: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

const ENV_KEYS = [
  'VAULT_BACKEND', 'VAULT_ADDR', 'VAULT_TOKEN', 'VAULT_ROLE_ID',
  'VAULT_SECRET_ID', 'VAULT_ALLOW_ENV_FALLBACK', 'A_SECRET',
];

function loggedError(): string {
  return vaultLogger.warn.mock.calls.map(call => {
    const context = call[0] as { err?: Error };
    return [context.err?.message ?? '', String(call[1] ?? '')].join(' ');
  }).join('\n');
}

beforeEach(() => {
  _clearVaultCache();
  mockFetch.mockReset();
  for (const fn of Object.values(vaultLogger)) fn.mockClear();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV = 'production';
  process.env.VAULT_BACKEND = 'hashicorp';
  process.env.VAULT_ADDR = 'https://vault.test';
  process.env.VAULT_ALLOW_ENV_FALLBACK = 'false';
});

afterEach(() => {
  _clearVaultCache();
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.NODE_ENV = 'test';
});

describe('HashiCorp Vault failure-body redaction', () => {
  it('does not read or log an AppRole rejection body, while reporting its status', async () => {
    process.env.VAULT_ROLE_ID = 'role-id';
    process.env.VAULT_SECRET_ID = 'secret-id';
    process.env.A_SECRET = 'old-env-value';
    const leaked = 'LEAKED_APPROLE_CREDENTIAL_FROM_RESPONSE';
    const responseText = jest.fn().mockResolvedValue(`{"detail":"${leaked}"}`);
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, text: responseText });

    await expect(getSecret('A_SECRET')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(responseText).not.toHaveBeenCalled();
    expect(loggedError()).toContain('AppRole auth başarısız (403)');
    expect(loggedError()).not.toContain(leaked);
    expect(loggedError()).not.toContain('secret-id');
    expect(loggedError()).not.toContain('old-env-value');
  });

  it.each([403, 500])('does not read or log a KV v2 error body (HTTP %s)', async status => {
    process.env.VAULT_TOKEN = 'hvs-private-operator-token';
    process.env.A_SECRET = 'old-env-value';
    const leaked = 'LEAKED_KV_SECRET_FROM_RESPONSE';
    const responseText = jest.fn().mockResolvedValue(`{"errors":["${leaked}"]}`);
    mockFetch.mockResolvedValueOnce({ ok: false, status, text: responseText });

    await expect(getSecret('A_SECRET')).resolves.toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(responseText).not.toHaveBeenCalled();
    expect(loggedError()).toContain(`KV okuma başarısız (${status})`);
    expect(loggedError()).not.toContain(leaked);
    expect(loggedError()).not.toContain('hvs-private-operator-token');
    expect(loggedError()).not.toContain('old-env-value');
  });

  it('preserves explicit development fallback without leaking the response body', async () => {
    process.env.NODE_ENV = 'development';
    process.env.VAULT_TOKEN = 'static-token';
    process.env.A_SECRET = 'opted-in-env-value';
    _clearVaultCache();
    const responseText = jest.fn().mockResolvedValue('LEAKED_PROVIDER_BODY');
    mockFetch.mockResolvedValueOnce({ ok: false, status: 502, text: responseText });

    await expect(getSecret('A_SECRET')).resolves.toBe('opted-in-env-value');
    expect(responseText).not.toHaveBeenCalled();
    expect(loggedError()).toContain('KV okuma başarısız (502)');
    expect(loggedError()).not.toContain('LEAKED_PROVIDER_BODY');
  });
});
