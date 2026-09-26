// server/lib/uploadRelease.ts
//
// SAHİBİ SİLİNEN KALICI VARLIK DOSYALARINI BIRAKMA (Final21 Faz 19)
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN
// ════════════════════════════════════════════════════════════════════════════
// Günlük temizlik işi (`jobs/cleanupUploads.ts`) BİLEREK yalnızca yükleme kökündeki
// mesaj eklerini toplar; alt dizinlerdeki kalıcı varlıklara (avatar, afiş, sunucu
// profili, emoji, ses, sunucu simgesi, GIF, kayıt) hiç dokunmaz, çünkü eksik bir
// referans listesi orada kalıcı veri kaybı demektir. Bu dosyaları yalnızca SAHİBİ olan
// uç siler (ör. `DELETE /me/avatar`, emoji silme).
//
// Ölçülen boşluk: sahibinin KAYDI toplu olarak silindiğinde — hesap silme, sunucudan
// ayrılma/atılma, yasak kaldırma, sunucu silme — hiçbir yol dosyaları bırakmıyordu.
// Kişinin fotoğrafları ve silinmiş bir sunucunun görselleri diskte kalıyor ve URL'yi
// bilen herkese sunulmaya devam ediyordu; hiçbir iş onları bir daha toplamıyordu.
//
// ── SÖZLEŞME ────────────────────────────────────────────────────────────────
// · Yalnızca AÇIKÇA tanınan varlık yolları bırakılır; eşlenmeyen hiçbir şey silinmez.
//   Çıkartma ağacı (`uploads/stickers/`) ve kök ekler (temizlik işinin alanı) KAPSAM DIŞI.
// · Her dosya için önce `hasLiveUploadReference`: başka bir kayıt hâlâ başvuruyorsa KALIR.
//   Denetim yapılamazsa (havuz yok, sorgu hatası) dosya SİLİNMEZ (fail-closed).
// · Silme mekanizması, o varlığın KENDİ sahibi olan uçla aynıdır:
//     yerel disk   → avatars, banners, member-profiles, emojis, soundboard, recordings
//                    (bu uçlar multer diskStorage + fs.unlink kullanır)
//     depolama adaptörü → server-assets, server-gifs (local/S3/R2/MinIO/B2;
//                    `serverAssets.ts` ve `serverGifs.ts` ile aynı yol)
// · Veritabanı yetkilidir: dosya bırakılamazsa çağıranın işlemi GERİ ALINMAZ; olay bildirilir.

import fs from 'fs';
import path from 'path';
import { hasLiveUploadReference, normalizeUploadKey, type UploadReferenceQueryable } from './uploadReferenceSafety';
import { uploadRoot } from './runtimePaths';
import { getStorageAdapter } from './storageAdapter';

const LOCAL_ASSET = /^\/uploads\/(avatars|banners|member-profiles|emojis|soundboard|recordings)\/([A-Za-z0-9][A-Za-z0-9._-]{0,200})$/;
const ADAPTER_PREFIXES = ['uploads/server-assets/', 'uploads/server-gifs/'];

export type AssetLocation =
  | { kind: 'local'; canonicalKey: string; filePath: string }
  | { kind: 'adapter'; canonicalKey: string; storageKey: string };

/** Tanınan bir kalıcı varlık yolunu çözer; tanınmayan her şey için `null` (silinmez). */
export function locateAsset(url: unknown): AssetLocation | null {
  if (typeof url !== 'string' || !url) return null;
  const local = LOCAL_ASSET.exec(url);
  const subdir = local?.[1];
  const fileName = local?.[2];
  if (subdir && fileName) {
    if (fileName.includes('..')) return null;
    return {
      kind: 'local',
      canonicalKey: `uploads/${subdir}/${fileName}`,
      filePath: path.join(uploadRoot(), subdir, fileName),
    };
  }
  const store = getStorageAdapter();
  const storageKey = store.keyFromUrl(url);
  const canonicalKey = normalizeUploadKey(storageKey.startsWith('uploads/') ? storageKey : `uploads/${storageKey}`);
  if (!canonicalKey || !ADAPTER_PREFIXES.some(p => canonicalKey.startsWith(p))) return null;
  return { kind: 'adapter', canonicalKey, storageKey };
}

export interface ReleaseResult { removed: number; alreadyAbsent: number; stillReferenced: number; failed: number }

/**
 * Sahibi olan kayıt(lar) SİLİNDİKTEN (işlem tamamlandıktan) sonra çağrılır.
 * Tanınmayan yollar sayılmaz ve dokunulmaz.
 */
export async function releaseUnreferencedUploads(
  queryable: UploadReferenceQueryable | null | undefined,
  urls: Iterable<string>,
  onError: (url: string, err: unknown) => void,
): Promise<ReleaseResult> {
  const result: ReleaseResult = { removed: 0, alreadyAbsent: 0, stillReferenced: 0, failed: 0 };
  for (const url of new Set(urls)) {
    const loc = locateAsset(url);
    if (!loc) continue;
    try {
      if (await hasLiveUploadReference(queryable, loc.canonicalKey)) { result.stillReferenced++; continue; }
      if (loc.kind === 'adapter') {
        await getStorageAdapter().deleteFile(loc.storageKey);
        result.removed++;
        continue;
      }
      try {
        fs.unlinkSync(loc.filePath);
        result.removed++;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        result.alreadyAbsent++;
      }
    } catch (err) {
      result.failed++;
      onError(url, err);
    }
  }
  return result;
}

/** `members.serverProfile` içindeki görsel yolları. */
export function memberProfileAssetUrls(rows: Iterable<{ serverProfile?: unknown }>): string[] {
  const out: string[] = [];
  for (const row of rows) {
    let profile = row.serverProfile;
    if (typeof profile === 'string') { try { profile = JSON.parse(profile); } catch { profile = null; } }
    if (!profile || typeof profile !== 'object') continue;
    for (const key of ['avatarUrl', 'bannerUrl']) {
      const v = (profile as Record<string, unknown>)[key];
      if (typeof v === 'string' && v) out.push(v);
    }
  }
  return out;
}
