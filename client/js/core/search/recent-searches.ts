// client/js/core/search/recent-searches.ts
//
// FAZ K/1 — SON ARAMALAR.
//
// Arama kutusunu bos acan kullaniciya gosterilecek TEK dogru sey, kendi
// yaptigi son aramalardir: sifir maliyetle geri donus saglar ve bos durumu
// olu bir yuzey olmaktan cikarir.
//
// TASARIM KARARLARI
//   • Yalnizca SORGU METNI saklanir — sonuc, kanal adi, mesaj icerigi DEGIL.
//     Sonuclari onbelleklemek, kullanicinin erisimi sonradan kaldirilmis bir
//     kanalin icerigini cihazda birakirdi; yetki sunucuda yasar ve her
//     acilista yeniden dogrulanmalidir.
//   • Depolama basarisiz olabilir (ozel mod, kota, devre disi birakilmis
//     storage). Bu bir arama hatasi DEGILDIR; sessizce yutulur ve arama
//     calismaya devam eder.

const STORAGE_KEY = 'bridge:recent-searches';

/** Ustu asildiginda en eskisi dusurulur. Liste tarama listesi degil, kisayoldur. */
export const MAX_RECENT = 8;

/** Cok uzun sorgular listeyi kullanilmaz kilar; depolamadan once kirpilir. */
const MAX_QUERY_LENGTH = 120;

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

function defaultStorage(): StorageLike | null {
  try {
    // Erisimin kendisi (ozel mod / kapali storage) firlatabilir.
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/**
 * Yeni sorguyu listenin basina ekler ve tekrarlari eler.
 *
 * SAF FONKSIYON — depolamadan bagimsiz test edilir.
 * Ayni sorguyu tekrar aramak onu yukari tasir, ikinci kayit OLUSTURMAZ;
 * aksi halde liste tek bir sorgunun kopyalariyla dolardi.
 */
export function addRecent(list: readonly string[], query: string): string[] {
  const value = query.trim().slice(0, MAX_QUERY_LENGTH);
  if (!value) return [...list];

  const lower = value.toLowerCase();
  const rest = list.filter(item => item.toLowerCase() !== lower);
  return [value, ...rest].slice(0, MAX_RECENT);
}

/** Tek bir kaydi siler (kullanici listeden cikarabilmelidir). */
export function removeRecent(list: readonly string[], query: string): string[] {
  const lower = query.trim().toLowerCase();
  return list.filter(item => item.toLowerCase() !== lower);
}

/** Depolanan ham degeri guvenli bir listeye cevirir. */
export function parseRecent(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === 'string')
      .map(item => item.trim().slice(0, MAX_QUERY_LENGTH))
      .filter(Boolean)
      .slice(0, MAX_RECENT);
  } catch {
    // Bozuk JSON kullanicinin sucu degil; arama yine de acilmalidir.
    return [];
  }
}

export function loadRecent(storage: StorageLike | null = defaultStorage()): string[] {
  if (!storage) return [];
  try {
    return parseRecent(storage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

export function saveRecent(list: readonly string[], storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    // Kota dolu / yazma engelli. Arama calismaya devam eder.
  }
}

export function clearRecent(storage: StorageLike | null = defaultStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(STORAGE_KEY);
  } catch {
    /* yoksayilir */
  }
}
