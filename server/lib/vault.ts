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
import crypto from 'crypto';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@smithy/signature-v4';
import type { HttpRequest } from '@smithy/types';

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
     
    const repos = tryRequire<{ Auth: { insertAuditLog(data: object): Promise<void> } }>('../db/repositories', require);
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
  allowEnvFallback?: boolean;
}

// ── Konfigürasyon singleton ───────────────────────────────────────────────────
// Config ortam değişkenlerinden bir kez okunur; test ortamında _resetConfig()
// ile sıfırlanabilir. Her getSecret() çağrısında process.env yeniden
// okunmadığı için gereksiz nesne allokasyonu ortadan kalkar.

let _config: VaultConfig | null = null;

const VAULT_BACKENDS = new Set<VaultBackend>(['hashicorp', 'aws', 'env']);

export function getVaultBackend(): VaultBackend {
  const raw = (process.env.VAULT_BACKEND || 'env').trim().toLowerCase();
  if (!VAULT_BACKENDS.has(raw as VaultBackend)) {
    throw new Error(`[vault] Unsupported VAULT_BACKEND: ${raw || '(empty)'}`);
  }
  return raw as VaultBackend;
}

function getConfig(): VaultConfig {
  if (_config) return _config;
  const backend = getVaultBackend();
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
    // A configured external secret backend is an authority boundary in
    // production. Silent downgrade to process.env is allowed only when
    // explicitly opted in; dev/test keeps the historical convenience.
    allowEnvFallback: process.env.VAULT_ALLOW_ENV_FALLBACK === 'true' || process.env.NODE_ENV !== 'production',
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

function hashicorpBaseUrl(cfg: VaultConfig): URL {
  if (!cfg.addr) throw new Error('[vault] VAULT_ADDR gerekli (backend=hashicorp).');
  const url = new URL(cfg.addr);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('[vault] VAULT_ADDR must be a credential-free origin URL.');
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('[vault] VAULT_ADDR must use HTTPS in production.');
  }
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('[vault] VAULT_ADDR must use HTTP(S).');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url;
}

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

  const base = hashicorpBaseUrl(cfg);
  const resp = await fetch(new URL(`${base.pathname}/v1/auth/approle/login`, base).toString(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ role_id: cfg.roleId, secret_id: cfg.secretId }),
    signal:  AbortSignal.timeout(10_000),
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
  const base = hashicorpBaseUrl(cfg);
  const mount = encodeURIComponent(cfg.mount ?? 'secret');
  const prefix = (cfg.pathPrefix ?? 'bridge').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  const key = encodeURIComponent(secretName);
  const relativePath = `${base.pathname}/v1/${mount}/data/${prefix}/${key}`.replace(/\/{2,}/g, '/');
  const url = new URL(relativePath, base);

  const resp = await fetch(url.toString(), {
    headers: { 'X-Vault-Token': token },
    signal: AbortSignal.timeout(10_000),
  });

  if (resp.status === 404) return null;
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`[vault] KV okuma başarısız (${resp.status}) — path: ${url.pathname}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as { data?: { data?: Record<string, string> } };
  return data?.data?.data?.[secretName] ?? null;
}

// ── AWS Secrets Manager okuma ─────────────────────────────────────────────────

/**
 * Smithy SignatureV4 needs a SHA-256/HMAC-SHA256 constructor.  Node's crypto
 * implementation keeps this dependency-free while preserving the standard AWS
 * credential provider chain (env, shared config, ECS/EC2 IAM roles, web identity).
 *
 * Both the key and every chunk are typed `SourceData` by @smithy/types, i.e.
 * `string | ArrayBuffer | ArrayBufferView` — not just `Uint8Array`. Narrowing
 * them broke `tsc -p tsconfig.build.json` outright and would have silently
 * mis-signed any request where Smithy handed over an ArrayBuffer/DataView.
 */
type SmithySourceData = string | ArrayBuffer | ArrayBufferView;

function toSigningBuffer(data: SmithySourceData): Buffer {
  if (typeof data === 'string') return Buffer.from(data, 'utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return Buffer.from(new Uint8Array(data));
}

/**
 * Test hook — the SigV4 digest adapter is otherwise reachable only through a
 * live AWS signing round trip. Exported so the SourceData contract (string /
 * ArrayBuffer / ArrayBufferView) and the HMAC-vs-hash selection can be
 * asserted directly, in the same spirit as _resetConfig/_clearVaultCache.
 */
export { toSigningBuffer as _toSigningBuffer };

class NodeSha256 {
  private readonly digestor: crypto.Hash | crypto.Hmac;

  constructor(secret?: SmithySourceData) {
    // An empty HMAC key is still an HMAC key: presence, not truthiness, picks
    // the algorithm (`''` and a zero-length view must not fall back to SHA-256).
    this.digestor = secret === undefined || secret === null
      ? crypto.createHash('sha256')
      : crypto.createHmac('sha256', toSigningBuffer(secret));
  }

  update(data: SmithySourceData): void {
    this.digestor.update(toSigningBuffer(data));
  }

  async digest(): Promise<Uint8Array> {
    return new Uint8Array(this.digestor.digest());
  }
}

function awsSecretsEndpoint(region: string): URL {
  const override = process.env.AWS_SECRETS_MANAGER_ENDPOINT?.trim();
  const raw = override || `https://secretsmanager.${region}.${region.startsWith('cn-') ? 'amazonaws.com.cn' : 'amazonaws.com'}`;
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('[vault] AWS Secrets Manager endpoint must be a credential-free HTTPS origin.');
  }
  return url;
}

async function readFromAws(secretName: string, cfg: VaultConfig): Promise<string | null> {
  const region = cfg.awsRegion ?? 'us-east-1';
  const endpoint = awsSecretsEndpoint(region);
  const body = JSON.stringify({ SecretId: `${cfg.awsPrefix ?? 'bridge/'}${secretName}` });

  const signer = new SignatureV4({
    credentials: defaultProvider(),
    region,
    service: 'secretsmanager',
    sha256: NodeSha256,
  });

  const request: HttpRequest = {
    method: 'POST',
    protocol: endpoint.protocol,
    hostname: endpoint.hostname,
    port: endpoint.port ? Number(endpoint.port) : undefined,
    path: endpoint.pathname || '/',
    query: {},
    headers: {
      host: endpoint.host,
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': 'secretsmanager.GetSecretValue',
      'content-length': String(Buffer.byteLength(body)),
    },
    body,
  };

  const signed = await signer.sign(request);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: signed.headers,
    body,
    signal: AbortSignal.timeout(10_000),
  });

  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text) {
    try { parsed = JSON.parse(text) as Record<string, unknown>; }
    catch { parsed = {}; }
  }

  if (!response.ok) {
    const type = String(parsed.__type ?? parsed.code ?? '');
    if (response.status === 404 || /ResourceNotFoundException/.test(type)) return null;
    throw new Error(`[vault] AWS Secrets Manager request failed (${response.status})`);
  }

  const str = typeof parsed.SecretString === 'string' ? parsed.SecretString : '';
  if (!str) return null;
  try {
    const value = JSON.parse(str) as Record<string, unknown>;
    const selected = value[secretName] ?? value.value;
    return typeof selected === 'string' ? selected : str;
  } catch {
    return str;
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
  options: { override?: boolean; audit?: boolean } = {},
): Promise<string | null> {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(secretName)) {
    throw new Error(`[vault] Invalid secret name: ${secretName}`);
  }
  if (!options.override) {
    const cached = cacheGet(secretName);
    if (cached !== null) return cached;
  }

  const cfg = getConfig();

  let value: string | null;

  try {
    switch (cfg.backend) {
      case 'hashicorp':
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
    const allowFallback = cfg.backend === 'env' || cfg.allowEnvFallback === true;
    logWarn(
      { err, secretName, backend: cfg.backend, allowEnvFallback: allowFallback, event: 'vault.get_secret.error' },
      allowFallback
        ? `[vault] ${secretName} okunamadı — env fallback deneniyor.`
        : `[vault] ${secretName} okunamadı — production secret authority fail-closed.`,
    );
    // External secret authority was selected explicitly. In production, do
    // not silently resurrect an older/local env secret unless operators opted
    // into that downgrade with VAULT_ALLOW_ENV_FALLBACK=true.
    value = allowFallback ? readFromEnv(secretName) : null;
  }

  // A clean "not found" response is not an exception, but explicit fallback
  // means the operator also permits process.env to satisfy an absent external key.
  if (value === null && cfg.backend !== 'env' && cfg.allowEnvFallback === true) {
    value = readFromEnv(secretName);
  }

  if (value !== null) {
    cacheSet(secretName, value);
    if (options.audit !== false) {
      void _auditVaultAccess(secretName, cfg.backend, true, false);
    }
  } else if (options.audit !== false) {
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

export { NodeSha256 as _NodeSha256 };

export default { getSecret, getSecrets, getVaultBackend, validateRequiredSecrets, _clearVaultCache, _resetConfig };
