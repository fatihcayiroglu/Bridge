// server/jobs/cleanupUploads.ts — Veritabanında referans kalmamış yükleme
// dosyalarını siler.
//
// Sunucu başladıktan 5 dakika sonra bir kez çalışır, ardından her 24 saatte bir
// tekrar eder.  Yarış koşulunu önlemek için yalnızca MAX_FILE_AGE_MS'den eski
// dosyalar dikkate alınır — yeni yüklenen ama henüz mesaja bağlanmamış bir dosya
// bu süre geçmeden silinmez.
//
// CDN_PROVIDER desteği (Sprint 53):
//   CDN_PROVIDER=local   → disk (varsayılan)
//   CDN_PROVIDER=r2      → Cloudflare R2
//   CDN_PROVIDER=minio   → MinIO
//   CDN_PROVIDER=s3      → AWS S3
//
// Sprint 54: Remote grace period düzeltmesi.
//   S3 listFiles() artık LastModified döndürüyor; local'de olduğu gibi
//   remote'da da MAX_FILE_AGE_MS filtresi uygulanır.
//   lastModifiedMs bilinmiyorsa dosya güvenli tarafta tutulur (silinmez).
//
// Sprint 62: OOM düzeltmesi — referenced URL'ler artık DB'den tüm satırlar
//   çekilmek yerine sadece fileUrl sütunu projection ile alınıyor.
//   PostgreSQL varsa tek bir UNION ALL sorgusu kullanılır (DB-side set operation).
//   Bu sayede büyük instance'larda bellek baskısı ortadan kalkar.

import logger from '../lib/logger';
import { getStorageAdapter } from '../lib/storageAdapter';
import { Messages, Dms } from '../db/repositories';
import db from '../db/loader';

const MAX_FILE_AGE_MS  = 10 * 60 * 1000;       // 10 dk — upload→DB insert yarış penceresi
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;  // 24 saat

/**
 * Veritabanındaki referanslı dosya key'lerini döndürür.
 *
 * PostgreSQL varsa tek UNION ALL sorgusuyla yalnızca fileUrl sütunu çekilir —
 * tüm satırları belleğe almaz. Aksi hâlde Collection API projection kullanılır.
 */
async function getReferencedKeys(keyFromUrl: (url: string) => string): Promise<Set<string>> {
  // PostgreSQL yolu — DB-side set operasyonu, yalnızca fileUrl sütunu
  if (db._pool?.query) {
    const { rows } = await db._pool.query<{ fileUrl: string }>(
      `SELECT "fileUrl" FROM messages    WHERE "fileUrl" IS NOT NULL
       UNION ALL
       SELECT "fileUrl" FROM dm_messages WHERE "fileUrl" IS NOT NULL`
    );
    return new Set(rows.map(r => keyFromUrl(r.fileUrl)));
  }

  // Collection API yolu — sadece fileUrl alanını project et
  const msgUrls = (await Messages.findProjected(
    { type: 'file' },
    { fileUrl: 1 }
  ) as Array<{ fileUrl?: string }>)
    .map(m => m.fileUrl)
    .filter((u): u is string => !!u);

  const dmUrls = (await Dms.findMessagesWhere(
    { fileUrl: { $exists: true } }
  ) as Array<{ fileUrl?: string }>)
    .map(m => m.fileUrl)
    .filter((u): u is string => !!u);

  return new Set([...msgUrls, ...dmUrls].map(keyFromUrl));
}

export async function runCleanup(): Promise<void> {
  const adapter  = getStorageAdapter();
  const provider = process.env.CDN_PROVIDER ?? 'local';

  let objects: Awaited<ReturnType<typeof adapter.listFiles>>;
  try {
    objects = await adapter.listFiles();
  } catch (err) {
    logger.error({ err, provider, event: 'cleanup.list.failed' }, '[cleanup] Dosya listesi alınamadı.');
    return;
  }

  if (!objects.length) return;

  const referenced = await getReferencedKeys(url => adapter.keyFromUrl(url));

  const now     = Date.now();
  let   deleted = 0;
  let   skipped = 0; // lastModifiedMs bilinmeyen uzak dosyalar

  for (const obj of objects) {
    // Referanslı dosyaya dokunma
    if (referenced.has(obj.key)) continue;

    // ── Grace period kontrolü ──────────────────────────────────────────────
    // lastModifiedMs hem yerel hem uzak adaptörlerden dolu gelir (Sprint 54).
    // Bilinmiyorsa (undefined) dosyayı güvenli tarafta tut — silme.
    if (obj.lastModifiedMs === undefined) {
      skipped++;
      logger.debug({ key: obj.key, provider }, '[cleanup] lastModifiedMs bilinmiyor — atlandı.');
      continue;
    }

    if (now - obj.lastModifiedMs < MAX_FILE_AGE_MS) {
      // Henüz çok yeni — bir sonraki çalışmada tekrar değerlendir
      continue;
    }

    try {
      await adapter.deleteFile(obj.key);
      deleted++;
    } catch (err) {
      // Yarış koşulunda dosya zaten silinmiş olabilir — hata değil
      logger.warn({ err, key: obj.key }, '[cleanup] Dosya silinemedi — atlandı.');
    }
  }

  if (deleted > 0 || skipped > 0) {
    logger.info({ deleted, skipped, provider }, '[cleanup] Sahipsiz yüklemeler işlendi.');
  }
}

let _cleanupInterval: ReturnType<typeof setInterval> | null = null;
let _cleanupInitTimer: ReturnType<typeof setTimeout> | null = null;

export function startCleanupJob(): void {
  if (_cleanupInitTimer !== null || _cleanupInterval !== null) return;
  // İlk çalışma: sunucu başladıktan 5 dakika sonra
  _cleanupInitTimer = setTimeout(() => {
    _cleanupInitTimer = null;
    runCleanup().catch((e: unknown) => logger.error({ err: e }, '[cleanup] Hata.'));
  }, 5 * 60 * 1000);
  _cleanupInitTimer.unref?.();

  // Sonraki çalışmalar: her 24 saatte bir
  _cleanupInterval = setInterval(() => {
    runCleanup().catch((e: unknown) => logger.error({ err: e }, '[cleanup] Hata.'));
  }, CLEANUP_INTERVAL);
  _cleanupInterval.unref?.();
}

// Sprint 98: Graceful shutdown desteği
export function stopCleanupJob(): void {
  if (_cleanupInitTimer !== null) {
    clearTimeout(_cleanupInitTimer);
    _cleanupInitTimer = null;
  }
  if (_cleanupInterval) {
    clearInterval(_cleanupInterval);
    _cleanupInterval = null;
    logger.info('[cleanup] Job durduruldu');
  }
}
