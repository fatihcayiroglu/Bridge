// server/lib/runtimeSecrets.ts
// Hydrates the production process environment from the configured external
// secret authority before the rest of the server module graph is imported.

import { getSecret, getVaultBackend } from './vault';

/**
 * Secrets required by Bridge's production env contract. Operators can replace
 * this list with VAULT_MANAGED_SECRETS when they intentionally split secret
 * ownership across systems.
 */
export const DEFAULT_VAULT_MANAGED_SECRETS = Object.freeze([
  'JWT_SECRET',
  'REFRESH_SECRET',
  'DATABASE_URL',
  'REDIS_URL',
  'AP_ENCRYPTION_KEY',
  'FEDERATION_SECRET',
  'METRICS_SECRET',
] as const);

const SECRET_NAME = /^[A-Z][A-Z0-9_]{0,127}$/;

export function configuredVaultManagedSecrets(): string[] {
  const configured = process.env.VAULT_MANAGED_SECRETS?.trim();
  const names = configured
    ? configured.split(',').map((name) => name.trim()).filter(Boolean)
    : [...DEFAULT_VAULT_MANAGED_SECRETS];

  const unique = [...new Set(names)];
  const invalid = unique.filter((name) => !SECRET_NAME.test(name));
  if (invalid.length) {
    throw new Error(`[vault] VAULT_MANAGED_SECRETS contains invalid names: ${invalid.join(', ')}`);
  }
  return unique;
}

export async function hydrateRuntimeSecrets(): Promise<void> {
  const backend = getVaultBackend();
  if (backend === 'env') return;

  const names = configuredVaultManagedSecrets();
  const values = await Promise.all(
    names.map(async (name) => [name, await getSecret(name, { audit: false })] as const),
  );

  for (const [name, value] of values) {
    if (value === null) {
      // An external backend is an authority boundary. A stale process-level
      // value must not silently satisfy the later env validator unless the
      // operator explicitly enabled VAULT_ALLOW_ENV_FALLBACK, in which case
      // getSecret() already returns that env value.
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
}
