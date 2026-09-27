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
//   MINIO_ACCESS_KEY     MinIO access key (zorunlu; production'da default minioadmin reddedilir)
//   MINIO_SECRET_KEY     MinIO secret key (zorunlu; production'da default minioadmin reddedilir)
//   MINIO_PUBLIC_URL     MinIO public download URL

import fs   from 'fs';
import path from 'path';
import logger from './logger';
import { tryRequire } from './_optional-require';
import { uploadRoot } from './runtimePaths';

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

export interface StorageReadResult {
  /** Provider'dan gelen okunabilir byte stream'i. */
  body: NodeJS.ReadableStream;
  contentType?: string;
  contentLength?: number;
  contentRange?: string;
  acceptRanges?: string;
  etag?: string;
  lastModified?: Date;
}

export interface StorageAdapter {
  /** Nesne listesi — key + lastModifiedMs içerir */
  listFiles(): Promise<StorageObject[]>;
  /** CDN'e dosya yükle, URL döndür */
  uploadFile(localPath: string, key: string, opts?: UploadOpts): Promise<UploadResult>;
  /** Yetkili uygulama proxy'si için nesneyi oku. */
  readFile(key: string, opts?: { range?: string }): Promise<StorageReadResult>;
  /** Dosya sil */
  deleteFile(key: string): Promise<void>;
  /** Upload URL'sinden key'i çıkar (örn. /uploads/foo.jpg → foo.jpg) */
  keyFromUrl(url: string): string;
  /** Bir storage key'i için sağlayıcıya ait kanonik servis URL'sini üret. */
  publicUrlForKey(key: string): string;
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
  send(command: IS3Command): Promise<unknown>;
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
  GetObjectCommand:     IS3CommandConstructor;
}

interface S3GetResult {
  Body?: unknown;
  ContentType?: string;
  ContentLength?: number;
  ContentRange?: string;
  AcceptRanges?: string;
  ETag?: string;
  LastModified?: Date;
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

// Kok HER ERISIMDE okunur, modul yuklenirken YAKALANMAZ.
//
// Yakalanmis bir deger, `BRIDGE_UPLOAD_ROOT` calisma aninda degistiginde eski
// dizini kullanmaya devam ederdi. Bu yalnizca bir test kolayligi degil:
// operator kokU degistirdiginde surecin dogru yere yazmasi gerekir.
function localUploadDir(): string { return uploadRoot(); }

export const localAdapter: StorageAdapter = {
  async listFiles(): Promise<StorageObject[]> {
    if (!fs.existsSync(localUploadDir())) return [];
    // FAZ J — YALNIZ DUZ DOSYALAR LISTELENIR.
    //
    // CANLI CALISTIRMADA GORULEN KUSUR: burasi `readdirSync` ciktisinin
    // TAMAMINI dosya gibi donduruyordu — alt DIZINLER dahil
    // (`member-profiles`, `server-assets`, `soundboard`, `_chunks`,
    // `_quarantine`, `stickers`). Temizlik isi bunlari `deleteFile` ile
    // silmeye calisiyor, o da `unlinkSync` cagirdigi icin dizinlerde
    // EPERM firlatiyordu. Sonuc: her temizlik dongusunde tekrarlayan hata
    // gurultusu (islevsel zarar yok, cunku hata yakalanip atlaniyordu).
    //
    // `statSync` zaten cagriliyordu; eksik olan tek sey `isFile()` suzgeciydi.
    // Bu duzeltme DAR kapsamlidir: dizinler artik LISTELENMEZ, dolayisiyla
    // asla silinmeye calisilmaz. Hicbir dizin OZYINELEMELI silinmez ve
    // `uploads/stickers` gibi tarihsel klasorler tumuyle dokunulmadan kalir.
    const out: StorageObject[] = [];
    for (const key of fs.readdirSync(localUploadDir())) {
      try {
        const stat = fs.statSync(path.join(localUploadDir(), key));
        // YALNIZ KESIN OLARAK DIZIN olanlar elenir.
        //
        // `isFile()` ZORUNLU TUTULMAZ: bazi cagiranlar/testler `statSync`ten
        // yalnizca `{ mtimeMs }` benzeri duz nesneler dondurur. `isFile()`
        // sart kosulsaydi bu girdiler sessizce listelenmez, temizlik hicbir
        // seyi degerlendiremezdi. Bu yuzden yalnizca `isDirectory()` VARSA ve
        // true ise atlanir — davranis degisikligi tam olarak kusurla sinirli.
        if (typeof (stat as { isDirectory?: () => boolean }).isDirectory === 'function'
            && (stat as { isDirectory: () => boolean }).isDirectory()) {
          continue;
        }
        out.push({ key, lastModifiedMs: (stat as { mtimeMs?: number }).mtimeMs });
      } catch {
        // ESKI SOZLESME KORUNUR: stat basarisizsa oge yine listelenir ama
        // `lastModifiedMs` undefined kalir; temizlik bu durumda dosyayi
        // GUVENLI TARAFTA tutup silmez (grace-period mantigi).
        out.push({ key });
      }
    }
    return out;
  },

  async uploadFile(localPath: string, _key: string, _opts: UploadOpts = {}): Promise<UploadResult> {
    // Local provider dosyayı upload dizininden servis eder; geçici dosya yaşam
    // döngüsünü çağıran katman yönetir. Remote adapter'ların deleteLocal
    // davranışını burada taklit etmek, testlerde ve local geliştirmede beklenmeyen
    // veri kaybına yol açabilir.
    //
    // Alt dizinleri KORU: server-assets/emojis gibi kalıcı varlıklar fiziksel
    // olarak server/uploads/<subdir>/ altında durur. Yalnız basename döndürmek
    // `/uploads/sa_x.png` üretip gerçek `/uploads/server-assets/sa_x.png` ile
    // ayrışıyordu. localPath uploads kökünün dışındaysa eski basename fallback'i
    // korunur (test/tool geçici dosyaları).
    const resolvedRoot = path.resolve(localUploadDir());
    const resolvedPath = path.resolve(localPath);
    const relative = path.relative(resolvedRoot, resolvedPath);
    const insideUploads = relative && !relative.startsWith('..') && !path.isAbsolute(relative);
    const key = insideUploads ? relative.split(path.sep).join('/') : path.basename(localPath);
    return { url: `/uploads/${key}`, key: null, provider: 'local' };
  },

  async readFile(key: string, opts: { range?: string } = {}): Promise<StorageReadResult> {
    // Local caller normalde express.static kullanır; bu uygulama yine de adapter
    // sözleşmesini tam tutar ve path traversal'a izin vermez.
    const normalizedKey = key.replace(/^uploads\//, '');
    const filePath = path.join(localUploadDir(), normalizedKey);
    const resolved = path.resolve(filePath);
    const root = path.resolve(localUploadDir()) + path.sep;
    if (!resolved.startsWith(root)) throw Object.assign(new Error('Invalid storage key'), { code: 'EINVAL' });

    const stat = fs.statSync(resolved);
    let start: number | undefined;
    let end: number | undefined;
    let contentRange: string | undefined;
    if (opts.range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(opts.range);
      if (!m) throw Object.assign(new Error('Invalid range'), { code: 'ERANGE' });
      start = m[1] ? Number(m[1]) : undefined;
      end = m[2] ? Number(m[2]) : undefined;
      if (start === undefined && end !== undefined) {
        const suffix = Math.min(end, stat.size);
        start = Math.max(0, stat.size - suffix);
        end = stat.size - 1;
      } else {
        start = start ?? 0;
        end = Math.min(end ?? stat.size - 1, stat.size - 1);
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= stat.size) {
        throw Object.assign(new Error('Unsatisfiable range'), { code: 'ERANGE', size: stat.size });
      }
      contentRange = `bytes ${start}-${end}/${stat.size}`;
    }

    const body = fs.createReadStream(resolved, start !== undefined ? { start, end } : undefined);
    return {
      body,
      contentType: mimeFromPath(resolved),
      contentLength: start !== undefined && end !== undefined ? end - start + 1 : stat.size,
      contentRange,
      acceptRanges: 'bytes',
      lastModified: stat.mtime,
    };
  },

  async deleteFile(key: string): Promise<void> {
    const filePath = path.join(localUploadDir(), key);
    // Path traversal koruması: çözümlenmiş yol uploads/ dizinin dışına çıkmamalı
    if (!path.resolve(filePath).startsWith(path.resolve(localUploadDir()) + path.sep)) {
      logger.warn({ key, event: 'storage.delete_traversal_blocked' }, 'Path traversal girişimi engellendi');
      throw Object.assign(new Error('Invalid storage key'), { code: 'EINVAL' });
    }
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  },

  keyFromUrl(url: string): string {
    // Local URL'lerde alt dizini koru: /uploads/server-assets/x.png
    // -> server-assets/x.png. Basename'e indirgemek deleteFile'ın yanlış kök
    // dosyasını hedeflemesine ve gerçek nesneyi orphan bırakmasına yol açıyordu.
    let pathname = url;
    try { pathname = new URL(url, 'http://bridge.local').pathname; } catch {}
    const marker = '/uploads/';
    const idx = pathname.indexOf(marker);
    if (idx >= 0) return pathname.slice(idx + marker.length).replace(/^\/+/, '');
    return path.basename(pathname);
  },

  publicUrlForKey(key: string): string {
    const normalized = key.replace(/^uploads\//, '');
    return `/uploads/${normalized}`;
  },

  async healthCheck(): Promise<boolean> {
    try {
      // A local provider is not healthy merely because it requires no network.
      // Readiness must catch a missing/read-only volume before accepting an
      // upload request that would fail after traffic has reached the node.
      fs.accessSync(localUploadDir(), fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch (err) {
      logger.error({ err, provider: 'local' }, '[storageAdapter] Yerel upload kökü erişilebilir/yazılabilir değil');
      return false;
    }
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
  /** Dosya URL'lerinin önüne eklenecek public base URL. Private adapter'da bilinçli olarak yoktur. */
  publicUrl?: string;
  /** Provider-level upload cache default. Protected buckets force private/no-store. */
  defaultCacheControl?: string;
}

export function buildS3Adapter(cfg: S3AdapterConfig): StorageAdapter {
  const sdk = requireS3Sdk(cfg.provider);
  const { S3Client, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } = sdk;

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

  const publicUrl = cfg.publicUrl?.replace(/\/$/, '') || null;

  return {
    async listFiles(): Promise<StorageObject[]> {
      const objects: StorageObject[] = [];
      let continuationToken: string | undefined;

      do {
        // `Delimiter: '/'` — YEREL ADAPTÖRLE AYNI SÖZLEŞME.
        //
        // Yerel `listFiles()` özyinelemeli DEĞİLDİR: yalnızca kök düzeyi
        // döndürür, alt dizinleri atlar. Uzak adaptör ise önek/ayırıcı
        // olmadan çağrıldığı için KOVANIN TAMAMINI döndürüyordu —
        // `stickers/`, `avatars/`, `server-assets/` dahil. Tek tüketici olan
        // temizlik işi için bu, kalıcı varlıkları silme adayı yapıyordu.
        //
        // Ayırıcı ile uzak liste de yalnızca kök düzeyi verir; alt dizinler
        // `CommonPrefixes` altında toplanır ve OKUNMAZ. Böylece iki mod
        // aynı davranışa oturur ve büyük kovalarda gereksiz sayfalama da
        // ortadan kalkar.
        const cmd = new ListObjectsV2Command({
          Bucket:            cfg.bucket,
          // Tüm Bridge upload nesneleri bu önek altında yaşar. Prefix olmadan
          // Delimiter='/' kullanmak gerçekte yalnız `uploads/` CommonPrefix'ini
          // döndürür ve kök mesaj eklerinin cleanup tarafından hiç görülmemesine
          // yol açar. Prefix + Delimiter yalnız `uploads/<dosya>` nesnelerini
          // listeler; `uploads/avatars/...` gibi kalıcı alt dizinleri dışarıda tutar.
          Prefix:            'uploads/',
          Delimiter:         '/',
          ContinuationToken: continuationToken,
          MaxKeys:           1000,
        });
        const res = await client.send(cmd) as S3ListResult;

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
        cacheControl = cfg.defaultCacheControl ?? 'public, max-age=31536000, immutable',
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

      return { url: publicUrl ? `${publicUrl}/${key}` : '', key, provider: cfg.provider };
    },

    async readFile(key: string, opts: { range?: string } = {}): Promise<StorageReadResult> {
      const input: S3CommandInput = { Bucket: cfg.bucket, Key: key };
      if (opts.range) input.Range = opts.range;
      const res = await client.send(new GetObjectCommand(input)) as S3GetResult;
      const body = res.Body as { pipe?: (dest: NodeJS.WritableStream) => unknown; on?: (...args: unknown[]) => unknown } | undefined;
      if (!body || typeof body.pipe !== 'function') {
        throw new Error(`[storageAdapter] ${cfg.provider}: GetObject body readable stream değil`);
      }
      return {
        body: body as unknown as NodeJS.ReadableStream,
        contentType: res.ContentType,
        contentLength: res.ContentLength,
        contentRange: res.ContentRange,
        acceptRanges: res.AcceptRanges ?? 'bytes',
        etag: res.ETag,
        lastModified: res.LastModified,
      };
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
        // Relative Bridge refs (`/uploads/<id>`) are canonical for protected
        // attachments, while absolute provider/CDN URLs remain supported for
        // legacy rows and public assets.
        const parsed = new URL(url, 'http://bridge.local');
        const parts  = parsed.pathname.split('/').filter(Boolean);
        if (parts[0] === cfg.bucket) parts.shift();
        return parts.join('/');
      } catch {
        return path.basename(url);
      }
    },

    publicUrlForKey(key: string): string {
      if (!publicUrl) {
        throw new Error(`[storageAdapter] ${cfg.provider}: private storage nesnelerinin public URL'si yoktur`);
      }
      return `${publicUrl}/${key.replace(/^\/+/, '')}`;
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
    accessKeyId:     process.env.MINIO_ACCESS_KEY ?? '',
    secretAccessKey: process.env.MINIO_SECRET_KEY ?? '',
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
// Protected attachment storage
// ─────────────────────────────────────────────────────────────────────────────
// Generic message/file and voice-message bytes are authorization-protected data.
// They MUST NOT share a publicly reachable CDN bucket with avatars/emoji/GIF/etc.
// `PRIVATE_STORAGE_PROVIDER` therefore has an independent singleton and defaults
// to local disk even when `CDN_PROVIDER` is remote. Remote private storage reuses
// the provider credentials/endpoints but REQUIRES a distinct private bucket.

function _privateBucketEnv(provider: CdnProvider): { key: string; value: string } {
  switch (provider) {
    case 's3':    return { key: 'PRIVATE_S3_BUCKET', value: process.env.PRIVATE_S3_BUCKET ?? '' };
    case 'r2':    return { key: 'PRIVATE_R2_BUCKET', value: process.env.PRIVATE_R2_BUCKET ?? '' };
    case 'minio': return { key: 'PRIVATE_MINIO_BUCKET', value: process.env.PRIVATE_MINIO_BUCKET ?? '' };
    case 'b2':    return { key: 'PRIVATE_B2_BUCKET_NAME', value: process.env.PRIVATE_B2_BUCKET_NAME ?? '' };
    default:      return { key: '', value: '' };
  }
}

function _publicBucketFor(provider: CdnProvider): string {
  switch (provider) {
    case 's3':    return process.env.S3_BUCKET ?? '';
    case 'r2':    return process.env.R2_BUCKET ?? '';
    case 'minio': return process.env.MINIO_BUCKET ?? 'bridge-uploads';
    case 'b2':    return process.env.B2_BUCKET_NAME ?? '';
    default:      return '';
  }
}

function _validateMinioDefaultCredentials(): void {
  const accessKey = process.env.MINIO_ACCESS_KEY ?? '';
  const secretKey = process.env.MINIO_SECRET_KEY ?? '';
  if (accessKey !== 'minioadmin' && secretKey !== 'minioadmin') return;

  if ((process.env.NODE_ENV ?? '').toLowerCase() === 'production') {
    throw new Error(
      '[storageAdapter] Production MinIO varsayılan minioadmin kimlik bilgileriyle başlatılamaz. ' +
      'MINIO_ACCESS_KEY ve MINIO_SECRET_KEY için benzersiz secret değerleri kullanın.',
    );
  }
  logger.warn(
    { event: 'storage.minio.default_credentials' },
    'SECURITY: MinIO varsayılan kimlik bilgileri kullanılıyor (minioadmin). Production ortamında bu yapılandırma reddedilir.',
  );
}

function _validatePrivateRemoteCredentials(provider: CdnProvider): void {
  const privateBucket = _privateBucketEnv(provider);
  const credentialKeys: Record<string, string[]> = {
    s3:    ['S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'],
    r2:    ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'],
    minio: ['MINIO_ENDPOINT', 'MINIO_ACCESS_KEY', 'MINIO_SECRET_KEY'],
    b2:    ['B2_KEY_ID', 'B2_APP_KEY'],
  };
  const missing = [privateBucket.key, ...(credentialKeys[provider] ?? [])]
    .filter(Boolean)
    .filter(key => !process.env[key]?.trim());
  if (missing.length) {
    throw new Error(
      `[storageAdapter] PRIVATE_STORAGE_PROVIDER=${provider} için zorunlu env değişkenleri eksik veya boş: ${missing.join(', ')}.`,
    );
  }
  if (provider === 'minio') _validateMinioDefaultCredentials();

  // A separate variable name is not enough: reject the exact same bucket when
  // the public CDN uses the same provider. Otherwise a public bucket policy or
  // custom CDN origin can bypass Bridge's current authorization middleware.
  if (getProvider() === provider) {
    const publicBucket = _publicBucketFor(provider).trim();
    if (publicBucket && publicBucket === privateBucket.value.trim()) {
      throw new Error(
        `[storageAdapter] Private attachment bucket (${privateBucket.key}) public CDN bucket ile aynı olamaz. ` +
        'Protected bytes için ayrı ve public olmayan bir bucket kullanın.',
      );
    }
  }
}

function _privateRemoteConfig(provider: CdnProvider): S3AdapterConfig {
  const bucket = _privateBucketEnv(provider).value;
  switch (provider) {
    case 's3':
      return {
        provider, bucket,
        region: process.env.S3_REGION ?? 'us-east-1',
        endpoint: process.env.S3_ENDPOINT,
        accessKeyId: process.env.S3_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY ?? '',
        defaultCacheControl: 'private, no-store',
      };
    case 'r2':
      return {
        provider, bucket, region: 'auto',
        endpoint: `https://${process.env.R2_ACCOUNT_ID ?? ''}.r2.cloudflarestorage.com`,
        accessKeyId: process.env.R2_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? '',
        defaultCacheControl: 'private, no-store',
      };
    case 'minio':
      return {
        provider, bucket, region: 'us-east-1',
        endpoint: (process.env.MINIO_ENDPOINT ?? '').replace(/\/$/, ''),
        accessKeyId: process.env.MINIO_ACCESS_KEY ?? '',
        secretAccessKey: process.env.MINIO_SECRET_KEY ?? '',
        forcePathStyle: true,
        defaultCacheControl: 'private, no-store',
      };
    case 'b2': {
      const region = process.env.B2_REGION ?? 'us-west-004';
      return {
        provider, bucket, region,
        endpoint: `https://s3.${region}.backblazeb2.com`,
        accessKeyId: process.env.B2_KEY_ID ?? '',
        secretAccessKey: process.env.B2_APP_KEY ?? '',
        defaultCacheControl: 'private, no-store',
      };
    }
    default:
      throw new Error(`[storageAdapter] Unsupported private storage provider: ${provider}`);
  }
}

let _privateAdapter: StorageAdapter | null = null;

export function getPrivateStorageProvider(): CdnProvider {
  return (process.env.PRIVATE_STORAGE_PROVIDER ?? 'local').toLowerCase() as CdnProvider;
}

export function getPrivateStorageAdapter(): StorageAdapter {
  if (_privateAdapter) return _privateAdapter;
  const provider = getPrivateStorageProvider();
  if (provider === 'local') {
    _privateAdapter = localAdapter;
    if (getProvider() !== 'local') {
      logger.warn(
        { publicProvider: getProvider(), privateProvider: provider, event: 'storage.private_local_with_remote_public' },
        '[storageAdapter] Public CDN remote, protected attachment storage local. Multi-node deployments should configure a shared PRIVATE_STORAGE_PROVIDER.',
      );
    }
    return _privateAdapter;
  }
  if (!['s3', 'r2', 'minio', 'b2'].includes(provider)) {
    throw new Error(`[storageAdapter] Bilinmeyen PRIVATE_STORAGE_PROVIDER=${provider}; fail-closed.`);
  }
  _validatePrivateRemoteCredentials(provider);
  _privateAdapter = buildS3Adapter(_privateRemoteConfig(provider));
  logger.info({ provider }, '[storageAdapter] Protected attachments private remote storage kullanıyor');
  return _privateAdapter;
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
  if (provider === 'minio') _validateMinioDefaultCredentials();
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
      throw new Error(`[storageAdapter] Bilinmeyen CDN_PROVIDER=${provider}; fail-closed.`);
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
  _privateAdapter = null;
}

// PROVIDER: modül yüklendiğinde sabit değil, her çağrıda env'den okunur.
// _resetAdapterForTest() sonrası CDN_PROVIDER değiştiğinde testler doğru provider görür.
export function getProvider(): CdnProvider {
  return (process.env.CDN_PROVIDER ?? 'local').toLowerCase() as CdnProvider;
}

/** @deprecated upload.ts içinde _cdnKey() için kullanılıyordu — getProvider() kullanın */
export const PROVIDER: CdnProvider = getProvider();
