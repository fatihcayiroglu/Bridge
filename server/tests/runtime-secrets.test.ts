process.env.NODE_ENV = 'test';

jest.mock('../lib/vault', () => ({
  getSecret: jest.fn(),
  getVaultBackend: jest.fn(),
}));

import {
  DEFAULT_VAULT_MANAGED_SECRETS,
  configuredVaultManagedSecrets,
  hydrateRuntimeSecrets,
} from '../lib/runtimeSecrets';
import * as vault from '../lib/vault';

const getSecret = vault.getSecret as jest.MockedFunction<typeof vault.getSecret>;
const getVaultBackend = vault.getVaultBackend as jest.MockedFunction<typeof vault.getVaultBackend>;
const touched = new Set<string>();

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VAULT_MANAGED_SECRETS;
  for (const name of DEFAULT_VAULT_MANAGED_SECRETS) {
    delete process.env[name];
    touched.add(name);
  }
});

afterAll(() => {
  for (const name of touched) delete process.env[name];
  delete process.env.VAULT_MANAGED_SECRETS;
});

test('env backend performs no secret hydration', async () => {
  getVaultBackend.mockReturnValue('env');
  await hydrateRuntimeSecrets();
  expect(getSecret).not.toHaveBeenCalled();
});

test('external backend hydrates the default production secret set before runtime import', async () => {
  getVaultBackend.mockReturnValue('hashicorp');
  getSecret.mockImplementation(async (name: string) => `vault:${name}`);

  await hydrateRuntimeSecrets();

  expect(getSecret).toHaveBeenCalledTimes(DEFAULT_VAULT_MANAGED_SECRETS.length);
  for (const name of DEFAULT_VAULT_MANAGED_SECRETS) {
    expect(process.env[name]).toBe(`vault:${name}`);
    expect(getSecret).toHaveBeenCalledWith(name, { audit: false });
  }
});

test('external authority removes stale local values when a managed secret is absent', async () => {
  getVaultBackend.mockReturnValue('aws');
  process.env.JWT_SECRET = 'stale-local-value';
  getSecret.mockImplementation(async (name: string) => name === 'JWT_SECRET' ? null : `vault:${name}`);

  await hydrateRuntimeSecrets();
  expect(process.env.JWT_SECRET).toBeUndefined();
});

test('VAULT_MANAGED_SECRETS is deduplicated and validated', () => {
  process.env.VAULT_MANAGED_SECRETS = 'SMTP_PASS, OPENAI_API_KEY, SMTP_PASS';
  expect(configuredVaultManagedSecrets()).toEqual(['SMTP_PASS', 'OPENAI_API_KEY']);

  process.env.VAULT_MANAGED_SECRETS = 'JWT_SECRET, ../escape';
  expect(() => configuredVaultManagedSecrets()).toThrow(/invalid names/i);
});
