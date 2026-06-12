// @ts-nocheck
// server/lib/vault.ts
// Sprint 112 — HashiCorp Vault / AWS Secrets Manager entegrasyonu
//
// Amaç:
//   AP private key gibi hassas sırları Vault'tan çekerek uygulama katmanında
//   `process.env` bağımlılığını minimize etmek.
//
// Desteklenen backend'ler:
//   - hashicorp: HashiCorp Vault (KV v2) — VAULT_ADDR + VAULT_TOKEN / VAULT_ROLE_ID+SECRET_ID
//   - aws:       AWS Secrets Manager   — AWS SDK ortam değişkenleri (IAM role önerilir)
//   - env:       Düz ortam değişkeni   — geliştirme/test için (varsayılan)
//
// Kullanım:
//   const { getSecret } = await import('./vault');
//   const apKey = await getSecret('AP_ENCRYPTION_KEY');
//
// Ortam değişkenleri:
//   VAULT_BACKEND     = hashicorp | aws | env  (varsayılan: env)
//   VAULT_ADDR        = https://vault.example.com:8200
//   VAULT_TOKEN       = hvs.xxxx  (ya da VAULT_ROLE_ID + VAULT_SECRET_ID için AppRole)
//   VAULT_ROLE_ID     = AppRole role ID
//   VAULT_SECRET_ID   = AppRole secret ID
//   VAULT_MOUNT       = secret  (KV v2 mount path, varsayılan: secret)
//   VAULT_PATH_PREFIX = bridge  (sır yolu prefix'i, varsayılan: bridge)
//   AWS_REGION        = us-east-1
//   AWS_SECRET_PREFIX = bridge/  (AWS Secrets Manager prefix)

import logger from './logger';

type VaultLogger = {
  warn?: (...args: unknown[]) => void;
  fatal?: (...args: unknown[]) => void;
  default?: VaultLogger;
};

function vaultLogger(): VaultLogger {
  const candidate = logger as unknown as VaultLogger;
  return candidate.default ?? candidate;
}

function logWarn(...args: unknown[]): void {
  vaultLogger().warn?.(...args);
}

function logFatal(...args: unknown[]): void {
  const active = vaultLogger();
  (active.fatal ?? active.warn)?.(...args);
}

// Sprint 120: ADR-0012 — Vault erişimleri Bridge audit_log tablosuna yazılır
// Sırlar okunduğunda hangi backend'den, hangi isimle, başarılı mı başarısız mı
// alındığı sistem audit_log'una (serverId=null, actorId='system') kaydedilir.
import { tryRequire } from './_optional-require';

// Lazy import — circular dependency'yi önlemek için
function _getAuth(): { insertAuditLog(data: object): Promise<void> } | null {
  try {
     
    const repos = tryRequire<{ Auth: { insertAuditLog(data: object): Promise<void> } }>('../db/repositories');
    return repos?.Auth ?? null;
  } catch { return null; }
}

async function _auditVaultAccess(secretName: string, backend: string, success: boolean, fromCache = false): Promise<void> {
  if (fromCache) return; // Cache hit'leri audit'e yazma — gürültü çok fazla olur
  try {
    const Auth = _getAuth();
    if (!Auth) return;
    await Auth.insertAuditLog({
      serverId: null,
      actorId:  'system',
      action:   success ? 'vault.secret.read' : 'vault.secret.read_failed',
      target:   secretName,
      extra:    { backend, timestamp: new Date().toISOString() },
    });
  } catch { /* audit log başarısız olsa bile getSecret akışını engelleme */ }
}

export type VaultBackend = 'hashicorp' | 'aws' | 'env';

export interface VaultConfig {
  backend:    VaultBackend;
  addr?:      string;
  token?:     string;
  roleId?:    string;
  secretId?:  string;
  mount?:     string;
  pathPrefix?: string;
  awsRegion?: string;
  awsPrefix?: string;
}

// ── Konfigürasyon singleton ───────────────────────────────────────────────────
// Config ortam değişkenlerinden bir kez okunur; test ortamında _resetConfig()
// ile sıfırlanabilir. Her getSecret() çağrısında process.env yeniden
// okunmadığı için gereksiz nesne allokasyonu ortadan kalkar.

let _config: VaultConfig | null = null;

function getConfig(): VaultConfig {
  if (_config) return _config;
  const backend = (process.env.VAULT_BACKEND || 'env') as VaultBackend;
  _config = {
    backend,
    addr:       process.env.VAULT_ADDR,
    token:      process.env.VAULT_TOKEN,
    roleId:     process.env.VAULT_ROLE_ID,
    secretId:   process.env.VAULT_SECRET_ID,
    mount:      process.env.VAULT_MOUNT       || 'secret',
    pathPrefix: process.env.VAULT_PATH_PREFIX || 'bridge',
    awsRegion:  process.env.AWS_REGION        || 'us-east-1',
    awsPrefix:  process.env.AWS_SECRET_PREFIX || 'bridge/',
  };
  return _config;
}

/** Test yardımcısı — config singleton'ı sıfırlar (env değişikliklerinin yansıması için) */
export function _resetConfig(): void {
  _config = null;
  _cache.clear();
}

// ── In-memory cache (TTL: 5 dakika) ──────────────────────────────────────────

interface CacheEntry { value: string; expiresAt: number; }
const _cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

function cacheGet(key: string): string | null {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.value;
}

function cacheSet(key: string, value: string): void {
  _cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

/**
 * Test yardımcısı — secret cache'ini, config singleton'ı ve Vault token
 * state'ini tamamen sıfırlar. Testler arası izolasyon için kullanın.
 */
export function _clearVaultCache(): void {
  _cache.clear();
  _config       = null;
  _vaultToken   = null;
  _vaultTokenExp = 0;
}

// ── HashiCorp Vault AppRole auth ──────────────────────────────────────────────

let _vaultToken: string | null = null;
let _vaultTokenExp = 0;

async function getVaultToken(cfg: VaultConfig): Promise<string> {
  if (_vaultToken && Date.now() < _vaultTokenExp) return _vaultToken;

  // Static token varsa doğrudan kullan
  if (cfg.token) {
    _vaultToken = cfg.token;
    _vaultTokenExp = Date.now() + 60 * 60 * 1000; // 1 saat
    return _vaultToken;
  }

  // AppRole auth
  if (!cfg.roleId || !cfg.secretId) {
    throw new Error('[vault] HashiCorp Vault için VAULT_TOKEN veya VAULT_ROLE_ID+VAULT_SECRET_ID gerekli.');
  }

  const resp = await fetch(`${cfg.addr}/v1/auth/approle/login`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ role_id: cfg.roleId, secret_id: cfg.secretId }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`[vault] AppRole auth başarısız (${resp.status}): ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as { auth?: { client_token: string; lease_duration: number } };
  if (!data.auth?.client_token) {
    throw new Error('[vault] AppRole yanıtında client_token bulunamadı.');
  }

  _vaultToken = data.auth.client_token;
  // Lease süresinin %90'ında yenile
  _vaultTokenExp = Date.now() + (data.auth.lease_duration * 0.9 * 1000);
  return _vaultToken;
}

// ── HashiCorp Vault KV v2 okuma ───────────────────────────────────────────────

async function readFromHashicorp(secretName: string, cfg: VaultConfig): Promise<string | null> {
  const token = await getVaultToken(cfg);
  const path  = `${cfg.addr}/v1/${cfg.mount}/data/${cfg.pathPrefix}/${secretName}`;

  const resp = await fetch(path, {
    headers: { 'X-Vault-Token': token },
  });

  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`[vault] KV okuma başarısız (${resp.status}) — path: ${path}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as { data?: { data?: Record<string, string> } };
  return data?.data?.data?.[secretName] ?? null;
}

// ── AWS Secrets Manager okuma ─────────────────────────────────────────────────

async function readFromAws(secretName: string, cfg: VaultConfig): Promise<string | null> {
  // AWS SDK dinamik import — opsiyonel bağımlılık
  let SecretsManagerClient: unknown, GetSecretValueCommand: unknown;
  try {
    const mod = await import('@aws-sdk/client-secrets-manager');
    SecretsManagerClient  = mod.SecretsManagerClient;
    GetSecretValueCommand = mod.GetSecretValueCommand;
  } catch {
    throw new Error('[vault] AWS Secrets Manager için @aws-sdk/client-secrets-manager paketi gerekli.');
  }

  const client  = new (SecretsManagerClient as new (cfg: { region: string }) => unknown)({ region: cfg.awsRegion });
  const command = new (GetSecretValueCommand as new (i: { SecretId: string }) => unknown)({
    SecretId: `${cfg.awsPrefix}${secretName}`,
  });

  try {
    const response = await (client as { send: (c: unknown) => Promise<{ SecretString?: string }> }).send(command);
    const str = response.SecretString;
    if (!str) return null;

    // JSON formatında saklanmış sır {"key": "value"}
    try {
      const parsed = JSON.parse(str) as Record<string, string>;
      return parsed[secretName] ?? parsed.value ?? str;
    } catch {
      return str; // Düz string
    }
  } catch (err: unknown) {
    const name = (err as { name?: string }).name;
    if (name === 'ResourceNotFoundException') return null;
    throw err;
  }
}

// ── Env fallback ──────────────────────────────────────────────────────────────

function readFromEnv(secretName: string): string | null {
  return process.env[secretName] ?? null;
}

// ── Ana getSecret fonksiyonu ──────────────────────────────────────────────────

/**
 * Verilen isimde sırrı yapılandırılmış backend'den çeker.
 *
 * @param secretName  Ortam değişkeni adı (örn. "AP_ENCRYPTION_KEY")
 * @param options     override: true ise cache'i atla
 * @returns Sır değeri ya da null (bulunamazsa)
 */
export async function getSecret(
  secretName: string,
  options: { override?: boolean } = {},
): Promise<string | null> {
  if (!options.override) {
    const cached = cacheGet(secretName);
    if (cached !== null) return cached;
  }

  const cfg = getConfig();

  let value: string | null = null;

  try {
    switch (cfg.backend) {
      case 'hashicorp':
        if (!cfg.addr) throw new Error('[vault] VAULT_ADDR gerekli (backend=hashicorp).');
        value = await readFromHashicorp(secretName, cfg);
        break;

      case 'aws':
        value = await readFromAws(secretName, cfg);
        break;

      case 'env':
      default:
        value = readFromEnv(secretName);
        break;
    }
  } catch (err) {
    logWarn(
      { err, secretName, backend: cfg.backend, event: 'vault.get_secret.error' },
      `[vault] ${secretName} okunamadı — env fallback deneniyor.`,
    );
    // Vault erişimi başarısız → env'e düş
    value = readFromEnv(secretName);
  }

  if (value !== null) {
    cacheSet(secretName, value);
    // Sprint 120: Vault erişimi başarılı — audit log'a yaz
    void _auditVaultAccess(secretName, cfg.backend, true, false);
  } else {
    // Sprint 120: Sır bulunamadı — audit log'a yaz
    void _auditVaultAccess(secretName, cfg.backend, false, false);
  }

  return value;
}

/**
 * Birden fazla sırrı tek seferde çeker.
 * @returns { [secretName]: value | null }
 */
export async function getSecrets(
  secretNames: string[],
): Promise<Record<string, string | null>> {
  const results = await Promise.all(
    secretNames.map(async name => [name, await getSecret(name)] as [string, string | null])
  );
  return Object.fromEntries(results);
}

/**
 * Kritik uygulama sırlarının mevcut olduğunu kontrol eder.
 * Eksik sırlar için uyarı loglar; production'da process.exit(1) çağırır.
 */
export async function validateRequiredSecrets(required: string[]): Promise<void> {
  const results = await getSecrets(required);
  const missing = required.filter(k => !results[k]);

  if (missing.length === 0) return;

  const msg = `[vault] Kritik sırlar eksik: ${missing.join(', ')}`;
  logFatal({ missing, event: 'vault.required_secrets_missing' }, msg);

  if (process.env.NODE_ENV === 'production') {
    process.exit(1);
  } else {
    logWarn({ missing, event: 'vault.required_secrets_missing_dev' }, `${msg} — development modunda devam ediliyor.`);
  }
}

export default { getSecret, getSecrets, validateRequiredSecrets, _clearVaultCache, _resetConfig };
