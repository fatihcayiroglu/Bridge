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
import { getPrivateStorageAdapter, getPrivateStorageProvider } from '../lib/storageAdapter';
import { Messages, Dms } from '../db/repositories';
import db from '../db/loader';

const MAX_FILE_AGE_MS  = 10 * 60 * 1000;       // 10 dk — upload→DB insert yarış penceresi
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;  // 24 saat

// ════════════════════════════════════════════════════════════════════════════
// YÜKLEMELERE REFERANS VEREN TÜM SÜTUNLAR
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN VERİ KAYBI: burası YALNIZCA `messages.fileUrl` ve
// `dm_messages.fileUrl` biliyordu. Referans kümesinde olmayan HER dosya
// siliniyordu. Yerel modda zarar sınırlıydı çünkü `listFiles()` özyinelemeli
// DEĞİLDİR (alt dizinler listelenmez). Ama uzak modda (`CDN_PROVIDER=s3|r2|
// minio|b2`) `ListObjectsV2` bir ÖNEK FİLTRESİ OLMADAN çağrılır: kovanın
// TAMAMI listelenir. Sonuç, günde bir çalışan bir işin avatarları, sunucu
// ikonlarını, emojileri, soundboard seslerini ve ÇIKARTMALARI kalıcı olarak
// silmesiydi.
//
// Aşağıdaki liste kanonik şemadaki (db/postgres/schema.ts) yükleme URL'si
// tutan TÜM sütunları kapsar. Yeni bir varlık türü eklenirse buraya da
// eklenmelidir — ancak unutulsa bile aşağıdaki KAPSAM KISITI (reapable)
// veri kaybını önler.
const URL_REFERENCES: Array<{ table: string; column: string }> = [
  { table: 'messages',           column: 'fileUrl'   },
  { table: 'messages',           column: 'avatarUrl' },  // webhook/bot avatarı
  { table: 'dm_messages',        column: 'fileUrl'   },
  { table: 'group_dm_messages',  column: 'fileUrl'   },
  { table: 'users',              column: 'avatarUrl' },
  { table: 'users',              column: 'bannerUrl' },
  { table: 'servers',            column: 'iconUrl'   },
  { table: 'servers',            column: 'bannerUrl' },
  { table: 'server_gifs',        column: 'url'       },
  { table: 'server_emojis',      column: 'url'       },
  { table: 'soundboard',         column: 'url'       },
  { table: 'voice_messages',      column: 'url'       },
  { table: 'sticker_pack_items', column: 'url'       },  // ÇIKARTMALAR
  { table: 'podcast_settings',   column: 'coverUrl'  },
  { table: 'podcast_settings',   column: 'imageUrl'  },
  { table: 'podcast_episodes',   column: 'audioUrl'  },
];

/**
 * Veritabanındaki referanslı dosya key'lerini döndürür.
 *
 * PostgreSQL varsa tek UNION ALL sorgusuyla yalnızca ilgili sütunlar çekilir —
 * tüm satırları belleğe almaz. Aksi hâlde Collection API projection kullanılır.
 */
async function getReferencedKeys(keyFromUrl: (url: string) => string): Promise<Set<string>> {
  // PostgreSQL yolu — destructive cleanup is fail-closed on schema drift.
  // Do NOT silently filter out missing/invisible columns via information_schema:
  // a partially visible schema could turn a legitimate live reference into an
  // apparent orphan. If any canonical owner is missing, this UNION fails and
  // runCleanup deletes nothing.
  if (typeof db._pool?.query === 'function') {
    const sql = [
      ...URL_REFERENCES
        .map(c => `SELECT "${c.column}" AS v FROM ${c.table} WHERE "${c.column}" IS NOT NULL`),
      // Podcast episodes may use the legacy filename-only contract. Runtime
      // serves that value as /uploads/<filename>, so normalize it to the same
      // URL shape before keyFromUrl() decides whether the root object is live.
      `SELECT '/uploads/' || filename AS v FROM podcast_episodes WHERE filename IS NOT NULL`,
    ]
      // ── Final21 Faz 8 — F21-8-01: TEKİLLEŞTİRME VERİTABANINDA ─────────────
      // Eskiden `UNION ALL` kullanılıyordu ve her URL satırı Node belleğine
      // taşınıp ancak orada `Set` ile tekilleştiriliyordu. Sprint 62 notu
      // "bellek baskısı ortadan kalkar" diyordu, ama `messages.avatarUrl` her
      // mesajda yazarın avatarını tutar: satır sayısı DOSYA sayısıyla değil
      // MESAJ sayısıyla büyür.
      //
      // ÖLÇÜLDÜ (1M mesaj, %60'ı avatar anlık görüntüsü taşıyor, gerçek PG 18,
      // ürünün birebir SQL'i):
      //     UNION ALL : 601 633 satır Node'a  ·  31 farklı anahtar  ·  heap +98.4 MB
      //     UNION     :      31 satır Node'a  ·  31 farklı anahtar  ·  heap  +0.7 MB
      //     sorgu süresi değişmedi (1 696 -> 1 686 ms)
      //
      // Bellek artık MESAJ sayısıyla değil, gerçekten gereken FARKLI referans
      // sayısıyla orantılı. Doğrusal uzatımla (ölçülmedi) 100M mesajda eski
      // biçim ~10 GB heap isterdi — günlük işin sunucu sürecini düşürmesi.
      // Referans KÜMESİ aynıdır; fail-closed davranışı aynıdır (herhangi bir
      // dal hata verirse sorgu düşer ve hiçbir şey silinmez).
      .join(' UNION ');
    const { rows } = await db._pool.query<{ v: string }>(sql);
    return new Set(rows.map(r => keyFromUrl(r.v)).filter(Boolean));
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

  // Group-DM attachments use the same root-level private upload namespace and
  // are therefore reapable objects. Missing this owner in fallback mode can
  // turn a live private attachment into an apparent orphan.
  const groupDmStore = (db as unknown as {
    groupDmMessages?: { find(q: Record<string, unknown>): PromiseLike<Array<{ fileUrl?: string }>> }
  }).groupDmMessages;
  if (!groupDmStore?.find) throw new Error('group_dm_messages reference store is unavailable');
  const groupDmRows = await groupDmStore.find({ fileUrl: { $exists: true } });
  if (!Array.isArray(groupDmRows)) throw new Error('group_dm_messages reference scan returned an invalid result');
  const groupDmUrls = groupDmRows.map(m => m.fileUrl).filter((u): u is string => !!u);

  return new Set([...msgUrls, ...dmUrls, ...groupDmUrls].map(keyFromUrl));
}


function canonicalOwnershipKey(storageKey: string): string {
  return storageKey.startsWith('uploads/') ? storageKey : `uploads/${storageKey}`;
}

/**
 * `uploads` is ownership/lifecycle metadata, not a content reference. Once an
 * old unreferenced physical object is successfully reaped, remove its stale
 * ownership row as well. The byte deletion decision has already been made from
 * the complete live-reference set; metadata cleanup failure is logged but can
 * never cause another object to be deleted.
 */
async function removeUploadOwnership(storageKey: string): Promise<void> {
  const key = canonicalOwnershipKey(storageKey);
  try {
    if (typeof db._pool?.query === 'function') {
      await db._pool.query('DELETE FROM uploads WHERE key = $1', [key]);
      return;
    }
    const uploads = (db as unknown as { uploads?: { remove?: (q: Record<string, unknown>) => Promise<unknown>; delete?: (q: Record<string, unknown>) => Promise<unknown> } }).uploads;
    if (uploads?.remove) await uploads.remove({ key });
    else if (uploads?.delete) await uploads.delete({ key });
  } catch (error) {
    logger.warn({ err: error, key, event: 'cleanup.upload_metadata_delete_failed' },
      '[cleanup] Physical object was removed but upload ownership metadata could not be deleted.');
  }
}

/**
 * Bu anahtar temizlik işinin SORUMLULUK ALANINDA mı?
 *
 * Mesaj ekleri depolamanın KÖKÜNE yazılır. Kalıcı varlıklar ise her zaman bir
 * ALT DİZİNDE yaşar: `stickers/`, `avatars/`, `banners/`, `server-assets/`,
 * `soundboard/`, `member-profiles/` ve dahili `_chunks/`, `_quarantine/`.
 *
 * Bu ayrım yeni bir kural değildir — yerel adaptörün davranışı ZATEN budur:
 * `listFiles()` özyinelemeli değildir, dizinleri atlar. Uzak adaptör ise
 * `ListObjectsV2`yi önek filtresi olmadan çağırdığı için kovanın tamamını
 * döndürür ve aynı korumadan yoksundu. Burası iki modu aynı sözleşmeye
 * oturtur: KÖK DÜZEYİ TEMİZLENİR, ALT DİZİNLERE DOKUNULMAZ.
 *
 * `server/uploads/stickers` bu kuralla kalıcı olarak kapsam dışıdır.
 */
export function isReapable(key: string): boolean {
  if (!key) return false;
  // Local adapter `foo.ext`, remote adapter ise gerçek object key'i olan
  // `uploads/foo.ext` döndürür. Her ikisi de AYNI mantıksal kök dosyadır.
  // `uploads/server-assets/x` gibi alt dizinler ise kalıcı varlıktır ve asla
  // bu işin sorumluluğuna girmez.
  const rel = key.startsWith('uploads/') ? key.slice('uploads/'.length) : key;
  if (!rel) return false;
  // Ters bölü de ayırıcı sayılır — Windows kaynaklı anahtarlar kapsam dışını
  // "kök" gibi göstermemeli.
  if (rel.includes('/') || rel.includes('\\')) return false;
  // Gizli/dahili girdiler (ör. `.gitkeep`, `_manifest`) korunur.
  if (rel.startsWith('.') || rel.startsWith('_')) return false;
  return true;
}

export async function runCleanup(): Promise<void> {
  const adapter  = getPrivateStorageAdapter();
  const provider = getPrivateStorageProvider();

  let objects: Awaited<ReturnType<typeof adapter.listFiles>>;
  try {
    objects = await adapter.listFiles();
  } catch (err) {
    logger.error({ err, provider, event: 'cleanup.list.failed' }, '[cleanup] Dosya listesi alınamadı.');
    return;
  }

  if (!objects.length) return;

  let referenced: Set<string>;
  try {
    referenced = await getReferencedKeys(url => adapter.keyFromUrl(url));
  } catch (err) {
    // Destructive maintenance must fail closed. A schema/store outage is not
    // evidence that every object is unreferenced.
    logger.error({ err, provider, event: 'cleanup.references.failed' }, '[cleanup] Referans kümesi güvenilir biçimde okunamadı; hiçbir dosya silinmedi.');
    return;
  }

  const now     = Date.now();
  let   deleted = 0;
  let   skipped = 0; // lastModifiedMs bilinmeyen uzak dosyalar

  for (const obj of objects) {
    // ── KAPSAM KISITI: iş YALNIZCA kendi alanını temizler ────────────────────
    // Referans listesini genişletmek tek başına yetmez; yarın yeni bir varlık
    // türü eklenip buraya yazılmazsa veri kaybı geri gelir. Bu yüzden karar
    // VARSAYILAN OLARAK HAYIRDIR: kapsam dışındaki hiçbir anahtar
    // değerlendirilmez bile.
    if (!isReapable(obj.key)) continue;

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
      await removeUploadOwnership(obj.key);
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
