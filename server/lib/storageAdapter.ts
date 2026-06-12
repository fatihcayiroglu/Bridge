// server/lib/storageAdapter.ts
// Provider-agnostic medya depolama katmanı.
//
// Desteklenen backend'ler (CDN_PROVIDER env):
//   local   — sunucu diski (server/uploads/)          [varsayılan]
//   s3      — AWS S3
//   r2      — Cloudflare R2 (S3-uyumlu)
//   minio   — self-hosted MinIO (S3-uyumlu)
//   b2      — Backblaze B2 (S3-uyumlu)
//
// Sprint 73: cdnStorage.ts kaldırıldı; uploadFile + deleteFile bu modüle taşındı.
//            upload.ts artık yalnızca bu modülü import eder.
//
// Kurulum (S3/R2/MinIO/B2):
//   cd server && npm install @aws-sdk/client-s3 @aws-sdk/lib-storage
//
// Ortam değişkenleri — tümü zorunlu değil, provider'a göre değişir:
//   CDN_PROVIDER         = local | s3 | r2 | minio | b2
//   S3_BUCKET            S3/MinIO/B2 bucket adı
//   S3_REGION            AWS region (varsayılan: us-east-1)
//   S3_ENDPOINT          MinIO / custom endpoint (ör. http://minio:9000)
//   S3_ACCESS_KEY_ID     access key
//   S3_SECRET_ACCESS_KEY secret key
//   S3_PUBLIC_URL        indirme URL prefix (ör. https://cdn.example.com)
//   R2_ACCOUNT_ID        Cloudflare hesap ID (yalnızca r2)
//   R2_ACCESS_KEY_ID     R2 API token key id
//   R2_SECRET_ACCESS_KEY R2 API token secret
//   R2_BUCKET            R2 bucket adı
//   R2_PUBLIC_URL        R2 public URL (Custom Domain veya r2.dev URL)
//   B2_KEY_ID            Backblaze application key ID
//   B2_APP_KEY           Backblaze application key
//   B2_BUCKET_NAME       Backblaze bucket adı
//   B2_REGION            Backblaze region (varsayılan: us-west-004)
//   B2_PUBLIC_URL        Backblaze public URL (opsiyonel)
//   MINIO_ENDPOINT       MinIO endpoint (varsayılan: http://minio:9000)
//   MINIO_BUCKET         MinIO bucket adı (varsayılan: bridge-uploads)
//   MINIO_ACCESS_KEY     MinIO access key (varsayılan: minioadmin)
//   MINIO_SECRET_KEY     MinIO secret key (varsayılan: minioadmin)
//   MINIO_PUBLIC_URL     MinIO public download URL

import fs   from 'fs';
import path from 'path';
import logger from './logger';
import { tryRequire } from './_optional-require';

// ─────────────────────────────────────────────────────────────────────────────
// Tip tanımları
// ─────────────────────────────────────────────────────────────────────────────

/** listFiles() tarafından döndürülen her nesneyi temsil eder. */
export interface StorageObject {
  /** Depolama key'i (yerel: dosya adı; remote: object key) */
  key: string;
  /**
   * Dosyanın son değiştirilme zamanı (ms epoch).
   * Yerel adaptörde fs.stat.mtimeMs, S3 adaptörlerinde LastModified.
   * Bilinmiyorsa undefined — cleanup grace period bu durumda güvenli tarafta kalır.
   */
  lastModifiedMs?: number;
}

/** uploadFile() dönüş değeri */
export interface UploadResult {
  /** Dosyaya erişim URL'si */
  url: string;
  /** Uzak depolamadaki nesne key'i; local modda null */
  key: string | null;
  /** Hangi backend kullanıldı */
  provider: CdnProvider;
}

export interface StorageAdapter {
  /** Nesne listesi — key + lastModifiedMs içerir */
  listFiles(): Promise<StorageObject[]>;
  /** CDN'e dosya yükle, URL döndür */
  uploadFile(localPath: string, key: string, opts?: UploadOpts): Promise<UploadResult>;
  /** Dosya sil */
  deleteFile(key: string): Promise<void>;
  /** Upload URL'sinden key'i çıkar (örn. /uploads/foo.jpg → foo.jpg) */
  keyFromUrl(url: string): string;
  /** Sağlık kontrolü — bağlantıyı test eder */
  healthCheck(): Promise<boolean>;
}

export interface UploadOpts {
  /** CDN'e yüklendikten sonra yerel dosyayı sil (varsayılan: true) */
  deleteLocal?: boolean;
  /** Content-Type; verilmezse uzantıdan tahmin edilir */
  contentType?: string;
  /** Cache-Control header (varsayılan: public, max-age=31536000, immutable) */
  cacheControl?: string;
}

export type CdnProvider = 'local' | 's3' | 'r2' | 'minio' | 'b2';

// ─────────────────────────────────────────────────────────────────────────────
// @aws-sdk/client-s3 için minimal tip interface
// (opsiyonel bağımlılık — as any yerine tryRequire<IS3Sdk> ile yüklenir)
// ─────────────────────────────────────────────────────────────────────────────

interface S3CommandInput {
  Bucket: string;
  [key: string]: unknown;
}

interface S3ListResult {
  Contents?: Array<{ Key?: string; LastModified?: Date }>;
  IsTruncated?: boolean;
  NextContinuationToken?: string;
}

interface IS3Client {
  send(command: IS3Command): Promise<S3ListResult>;
}

interface IS3ClientConstructor {
  new(config: {
    region: string;
    endpoint?: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
    forcePathStyle?: boolean;
  }): IS3Client;
}

interface IS3Command {}
interface IS3CommandConstructor {
  new(input: S3CommandInput): IS3Command;
}

/** @aws-sdk/client-s3'ten ihtiyacımız olan minimal yüzey */
interface IS3Sdk {
  S3Client:             IS3ClientConstructor;
  ListObjectsV2Command: IS3CommandConstructor;
  PutObjectCommand:     IS3CommandConstructor;
  DeleteObjectCommand:  IS3CommandConstructor;
}

// ─────────────────────────────────────────────────────────────────────────────
// Yardımcı fonksiyonlar
// ─────────────────────────────────────────────────────────────────────────────

const MIME_MAP: Record<string, string> = {
  '.jpg':  'image/jpeg',  '.jpeg': 'image/jpeg',
  '.png':  'image/png',   '.gif':  'image/gif',
  '.webp': 'image/webp',  '.svg':  'image/svg+xml',
  '.pdf':  'application/pdf',
  '.mp4':  'video/mp4',   '.webm': 'video/webm',
  '.mp3':  'audio/mpeg',  '.ogg':  'audio/ogg',
  '.wav':  'audio/wav',   '.flac': 'audio/flac',
  '.aac':  'audio/aac',
};

function mimeFromPath(filePath: string): string {
  return MIME_MAP[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function requireS3Sdk(provider: CdnProvider): IS3Sdk {
  const sdk = tryRequire<IS3Sdk>('@aws-sdk/client-s3');
  if (!sdk) {
    throw new Error(
      `CDN_PROVIDER=${provider} seçildi ama @aws-sdk/client-s3 kurulu değil. ` +
      `Çalıştırın: cd server && npm install @aws-sdk/client-s3`,
    );
  }
  return sdk;
}

// ─────────────────────────────────────────────────────────────────────────────
// Local adapter
// ─────────────────────────────────────────────────────────────────────────────

const LOCAL_UPLOAD_DIR = path.join(__dirname, '../uploads');

export const localAdapter: StorageAdapter = {
  async listFiles(): Promise<StorageObject[]> {
    if (!fs.existsSync(LOCAL_UPLOAD_DIR)) return [];
    return fs.readdirSync(LOCAL_UPLOAD_DIR).map(key => {
      try {
        const stat = fs.statSync(path.join(LOCAL_UPLOAD_DIR, key));
        return { key, lastModifiedMs: stat.mtimeMs };
      } catch {
        return { key };
      }
    });
  },

  async uploadFile(localPath: string, _key: string, _opts: UploadOpts = {}): Promise<UploadResult> {
    // Local provider dosyayı upload dizininden servis eder; geçici dosya yaşam
    // döngüsünü çağıran katman yönetir. Remote adapter'ların deleteLocal
    // davranışını burada taklit etmek, testlerde ve local geliştirmede beklenmeyen
    // veri kaybına yol açabilir.
    const filename = path.basename(localPath);
    return { url: `/uploads/${filename}`, key: null, provider: 'local' };
  },

  async deleteFile(key: string): Promise<void> {
    const filePath = path.join(LOCAL_UPLOAD_DIR, key);
    // Path traversal koruması: çözümlenmiş yol uploads/ dizinin dışına çıkmamalı
    if (!path.resolve(filePath).startsWith(path.resolve(LOCAL_UPLOAD_DIR) + path.sep)) {
      logger.warn({ key, event: 'storage.delete_traversal_blocked' }, 'Path traversal girişimi engellendi');
      return;
    }
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },

  keyFromUrl(url: string): string {
    return path.basename(url);
  },

  async healthCheck(): Promise<boolean> {
    return true;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// S3-uyumlu adapter factory (AWS S3 / Cloudflare R2 / MinIO / Backblaze B2)
// ─────────────────────────────────────────────────────────────────────────────

export interface S3AdapterConfig {
  provider:  CdnProvider;
  bucket:    string;
  region:    string;
  endpoint?: string;
  accessKeyId:     string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
  /** Dosya URL'lerinin önüne eklenecek public base URL */
  publicUrl: string;
}

export function buildS3Adapter(cfg: S3AdapterConfig): StorageAdapter {
  const sdk = requireS3Sdk(cfg.provider);
  const { S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } = sdk;

  if (!cfg.bucket) throw new Error(`[storageAdapter] ${cfg.provider}: bucket zorunlu`);

  const client: IS3Client = new S3Client({
    region:    cfg.region,
    endpoint:  cfg.endpoint,
    credentials: {
      accessKeyId:     cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
    forcePathStyle: cfg.forcePathStyle ?? false,
  });

  const publicUrl = cfg.publicUrl.replace(/\/$/, '');

  return {
    async listFiles(): Promise<StorageObject[]> {
      const objects: StorageObject[] = [];
      let continuationToken: string | undefined;

      do {
        const cmd = new ListObjectsV2Command({
          Bucket:            cfg.bucket,
          ContinuationToken: continuationToken,
          MaxKeys:           1000,
        });
        const res = await client.send(cmd);

        for (const obj of res.Contents ?? []) {
          if (!obj.Key) continue;
          objects.push({
            key:            obj.Key,
            lastModifiedMs: obj.LastModified instanceof Date
              ? obj.LastModified.getTime()
              : undefined,
          });
        }

        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuationToken);

      return objects;
    },

    async uploadFile(
      localPath: string,
      key: string,
      opts: UploadOpts = {},
    ): Promise<UploadResult> {
      const {
        deleteLocal  = true,
        contentType  = mimeFromPath(localPath),
        cacheControl = 'public, max-age=31536000, immutable',
      } = opts;

      const body = fs.createReadStream(localPath);
      const cmd  = new PutObjectCommand({
        Bucket:       cfg.bucket,
        Key:          key,
        Body:         body,
        ContentType:  contentType,
        CacheControl: cacheControl,
      });

      await client.send(cmd);
      logger.info({ provider: cfg.provider, key, event: 'storage.upload_ok' }, 'Dosya yüklendi');

      if (deleteLocal) {
        fs.unlink(localPath, (err) => {
          if (err) logger.warn({ err, localPath, event: 'storage.local_delete_failed' },
            'Geçici dosya silinemedi');
        });
      }

      return { url: `${publicUrl}/${key}`, key, provider: cfg.provider };
    },

    async deleteFile(key: string): Promise<void> {
      await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }));
    },

    keyFromUrl(url: string): string {
      // Desteklenen URL formatları:
      //   https://<public-url>/<key>
      //   https://s3.amazonaws.com/<bucket>/<key>
      //   https://<bucket>.s3.amazonaws.com/<key>
      try {
        const parsed = new URL(url);
        const parts  = parsed.pathname.split('/').filter(Boolean);
        if (parts[0] === cfg.bucket) parts.shift();
        return parts.join('/');
      } catch {
        return path.basename(url);
      }
    },

    async healthCheck(): Promise<boolean> {
      try {
        await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, MaxKeys: 1 }));
        return true;
      } catch (err) {
        logger.error({ err, provider: cfg.provider }, '[storageAdapter] Sağlık kontrolü başarısız');
        return false;
      }
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Provider config builders
// ─────────────────────────────────────────────────────────────────────────────

function _s3Config(): S3AdapterConfig {
  const bucket = process.env.S3_BUCKET ?? '';
  const region = process.env.S3_REGION ?? 'us-east-1';
  return {
    provider:  's3',
    bucket,
    region,
    endpoint:  process.env.S3_ENDPOINT,
    accessKeyId:     process.env.S3_ACCESS_KEY_ID     ?? '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
    publicUrl: process.env.S3_PUBLIC_URL
      ?? `https://s3.${region}.amazonaws.com/${bucket}`,
  };
}

function _r2Config(): S3AdapterConfig {
  const bucket = process.env.R2_BUCKET ?? '';
  return {
    provider:  'r2',
    bucket,
    region:    'auto',
    endpoint:  `https://${process.env.R2_ACCOUNT_ID ?? ''}.r2.cloudflarestorage.com`,
    accessKeyId:     process.env.R2_ACCESS_KEY_ID     ?? '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
    publicUrl: process.env.R2_PUBLIC_URL ?? '',
  };
}

function _minioConfig(): S3AdapterConfig {
  const endpoint  = (process.env.MINIO_ENDPOINT ?? 'http://minio:9000').replace(/\/$/, '');
  const bucket    = process.env.MINIO_BUCKET    ?? 'bridge-uploads';
  return {
    provider:  'minio',
    bucket,
    region:    'us-east-1',
    endpoint,
    // Not: MINIO_ACCESS_KEY ve MINIO_SECRET_KEY _validateRemoteCredentials tarafından
    // zorunlu kılınır; boş string veya 'minioadmin' gibi varsayılan değerler
    // _validateRemoteCredentials'ı geçemez — bu satırlara asla ulaşılmamalı.
    accessKeyId:     process.env.MINIO_ACCESS_KEY ?? '',
    secretAccessKey: process.env.MINIO_SECRET_KEY ?? '',
    // SECURITY: MinIO varsayılan kimlik bilgilerini tespit et
    ...(() => {
      const accessKey = process.env.MINIO_ACCESS_KEY ?? '';
      const secretKey = process.env.MINIO_SECRET_KEY ?? '';
      if (accessKey === 'minioadmin' || secretKey === 'minioadmin') {
        logger.warn(
          { event: 'storage.minio.default_credentials' },
          'SECURITY: MinIO varsayılan kimlik bilgileri kullanılıyor (minioadmin). ' +
          'Production ortamında MINIO_ACCESS_KEY ve MINIO_SECRET_KEY değiştirin!'
        );
      }
      return {};
    })(),
    forcePathStyle:  true,
    publicUrl: (process.env.MINIO_PUBLIC_URL ?? `${endpoint}/${bucket}`).replace(/\/$/, ''),
  };
}

function _b2Config(): S3AdapterConfig {
  const region = process.env.B2_REGION ?? 'us-west-004';
  const bucket = process.env.B2_BUCKET_NAME ?? '';
  return {
    provider:  'b2',
    bucket,
    region,
    endpoint:  `https://s3.${region}.backblazeb2.com`,
    accessKeyId:     process.env.B2_KEY_ID  ?? '',
    secretAccessKey: process.env.B2_APP_KEY ?? '',
    publicUrl: process.env.B2_PUBLIC_URL
      ?? `https://f000.backblazeb2.com/file/${bucket}`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory / singleton
// ─────────────────────────────────────────────────────────────────────────────

let _adapter: StorageAdapter | null = null;

/**
 * Remote provider credential validation — eksik veya boş zorunlu env değerleri
 * varsa uygulama başlatılmadan hata fırlatır (fail-fast).
 *
 * Sprint 74: S3/R2/MinIO/B2 için boş string ile sessizce devam etmek yerine
 * açık bir startup hatası verilir; böylece yapılandırma hatası ilk upload
 * anında değil, process başlangıcında fark edilir.
 */
function _validateRemoteCredentials(provider: CdnProvider): void {
  type EnvCheck = { key: string; label: string };

  const checks: Record<string, EnvCheck[]> = {
    s3: [
      { key: 'S3_BUCKET',            label: 'S3_BUCKET' },
      { key: 'S3_ACCESS_KEY_ID',     label: 'S3_ACCESS_KEY_ID' },
      { key: 'S3_SECRET_ACCESS_KEY', label: 'S3_SECRET_ACCESS_KEY' },
    ],
    r2: [
      { key: 'R2_BUCKET',            label: 'R2_BUCKET' },
      { key: 'R2_ACCOUNT_ID',        label: 'R2_ACCOUNT_ID' },
      { key: 'R2_ACCESS_KEY_ID',     label: 'R2_ACCESS_KEY_ID' },
      { key: 'R2_SECRET_ACCESS_KEY', label: 'R2_SECRET_ACCESS_KEY' },
      { key: 'R2_PUBLIC_URL',        label: 'R2_PUBLIC_URL' },
    ],
    minio: [
      { key: 'MINIO_ENDPOINT',   label: 'MINIO_ENDPOINT' },
      { key: 'MINIO_BUCKET',     label: 'MINIO_BUCKET' },
      { key: 'MINIO_ACCESS_KEY', label: 'MINIO_ACCESS_KEY' },
      { key: 'MINIO_SECRET_KEY', label: 'MINIO_SECRET_KEY' },
    ],
    b2: [
      { key: 'B2_BUCKET_NAME', label: 'B2_BUCKET_NAME' },
      { key: 'B2_KEY_ID',      label: 'B2_KEY_ID' },
      { key: 'B2_APP_KEY',     label: 'B2_APP_KEY' },
    ],
  };

  const required = checks[provider] ?? [];
  const missing  = required.filter(c => !process.env[c.key]?.trim());

  if (missing.length > 0) {
    const vars = missing.map(c => c.label).join(', ');
    throw new Error(
      `[storageAdapter] CDN_PROVIDER=${provider} için zorunlu env değişkenleri eksik veya boş: ${vars}. ` +
      `Lütfen .env dosyasını kontrol edin.`,
    );
  }
}

export function getStorageAdapter(): StorageAdapter {
  if (_adapter) return _adapter;

  const provider = (process.env.CDN_PROVIDER ?? 'local').toLowerCase() as CdnProvider;

  switch (provider) {
    case 'local':
      logger.info({ provider }, '[storageAdapter] Yerel disk kullanılıyor (server/uploads/)');
      _adapter = localAdapter;
      break;

    case 's3':
      _validateRemoteCredentials('s3');
      logger.info({ provider }, '[storageAdapter] AWS S3 kullanılıyor');
      _adapter = buildS3Adapter(_s3Config());
      break;

    case 'r2':
      _validateRemoteCredentials('r2');
      logger.info({ provider }, '[storageAdapter] Cloudflare R2 kullanılıyor');
      _adapter = buildS3Adapter(_r2Config());
      break;

    case 'minio':
      _validateRemoteCredentials('minio');
      logger.info({ provider }, '[storageAdapter] MinIO kullanılıyor');
      _adapter = buildS3Adapter(_minioConfig());
      break;

    case 'b2':
      _validateRemoteCredentials('b2');
      logger.info({ provider }, '[storageAdapter] Backblaze B2 kullanılıyor');
      _adapter = buildS3Adapter(_b2Config());
      break;

    default:
      logger.warn({ provider }, '[storageAdapter] Bilinmeyen CDN_PROVIDER, local kullanılıyor');
      _adapter = localAdapter;
  }

  return _adapter;
}

/**
 * Test ortamında adapter singleton'ını sıfırla.
 *
 * @remarks
 * `getStorageAdapter()` module-level bir `_adapter` değişkenini önbelleğe alır.
 * Bu değişken test suite'ler arası sızar ve CDN_PROVIDER ortam değişkenini
 * değiştirsen bile eski adapter kullanılmaya devam eder.
 *
 * **Her test dosyasında `getStorageAdapter()` veya CDN_PROVIDER kullanıyorsan
 * afterEach içinde bu fonksiyonu çağır:**
 *
 * ```typescript
 * import { _resetAdapterForTest } from '../lib/storageAdapter';
 * afterEach(() => { _resetAdapterForTest(); });
 * ```
 */
export function _resetAdapterForTest(): void {
  _adapter = null;
}

// PROVIDER: modül yüklendiğinde sabit değil, her çağrıda env'den okunur.
// _resetAdapterForTest() sonrası CDN_PROVIDER değiştiğinde testler doğru provider görür.
export function getProvider(): CdnProvider {
  return (process.env.CDN_PROVIDER ?? 'local').toLowerCase() as CdnProvider;
}

/** @deprecated upload.ts içinde _cdnKey() için kullanılıyordu — getProvider() kullanın */
export const PROVIDER: CdnProvider = getProvider();
