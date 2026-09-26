// server/lib/runtimePaths.ts
//
// ════════════════════════════════════════════════════════════════════════════
// KANONİK ÇALIŞMA ZAMANI VERİ KÖKÜ
// ════════════════════════════════════════════════════════════════════════════
// ÖLÇÜLEN KUSUR: 12 üretim dosyası yükleme kökünü
//
//     path.join(__dirname, '../uploads')
//
// olarak hesaplıyordu. `__dirname` DERLENMİŞ konuma bağlıdır:
//
//     kaynaktan (ts-node)  __dirname = server/routes      -> server/uploads      ✔
//     derlenmiş (node)     __dirname = server/dist/routes -> server/dist/uploads ✘
//
// Yani ÜRETİMDE çalışan sunucu, kullanıcı yüklemelerini DERLEME ÇIKTISININ
// içine yazıyordu. Bu incelemede `server/dist/uploads/` altında 83 MB gerçek
// çalışma zamanı verisi ölçüldü (154 adet e2e parça dizini dâhil).
//
// ── NEDEN BU BİR VERİ KAYBI TEHLİKESİDİR ───────────────────────────────────
// `dist/` ÜRETİLEN çıktıdır. Sıradan bir dağıtım adımı onu siler ve yeniden
// üretir (`rm -rf dist && npm run build`), bir Docker imajı onu yeni bir
// katmanla değiştirir. Her iki durumda da TÜM KULLANICI YÜKLEMELERİ yok olur.
// Ayrıca yedekleme yordamları `dist/`i tipik olarak "türetilmiş, yedeklenmez"
// sayar — yani kayıp sessiz ve geri dönüşsüz olur.
//
// ── SÖZLEŞME ────────────────────────────────────────────────────────────────
// · Kaynak ağacı KAYNAKTIR.
// · `dist/` ÜRETİLMİŞ çıktıdır ve çalışma zamanı durumu İÇERMEZ.
// · Çalışma zamanı verisi üretilmiş kodun DIŞINDA yaşar.
// · Kök, derlenmiş olsun olmasın AYNI dizini verir.
// · Testler `BRIDGE_UPLOAD_ROOT` ile tek kullanımlık bir dizine yönlendirir.

import fs from 'fs';
import path from 'path';

/**
 * `server/` dizinini bulur — derlenmiş de olsa kaynaktan da çalışsa AYNI yeri.
 *
 * Bu dosya iki yerden birinde durur:
 *   server/lib/runtimePaths.ts        (ts-node)
 *   server/dist/lib/runtimePaths.js   (derlenmiş)
 *
 * `dist` yol PARÇASI aranır (alt dizge değil): `path.sep` ile sınırlandığı
 * için `my-dist-tool/` gibi bir klasör adı yanlışlıkla eşleşmez.
 */
function resolveServerRoot(dir: string): string {
  const parts = dir.split(path.sep);
  const distIndex = parts.lastIndexOf('dist');
  if (distIndex > 0) return parts.slice(0, distIndex).join(path.sep);
  return path.resolve(dir, '..');
}

export const SERVER_ROOT = resolveServerRoot(__dirname);

/**
 * Çalışma zamanı yükleme kökü.
 *
 * Öncelik:
 *   1. `BRIDGE_UPLOAD_ROOT` — operatör/test denetimi (kalıcı birim, testte tmp)
 *   2. `<server>/uploads`   — derlenmiş olup olmamasından BAĞIMSIZ
 */
export function uploadRoot(): string {
  const override = process.env.BRIDGE_UPLOAD_ROOT?.trim();
  return override ? path.resolve(override) : path.join(SERVER_ROOT, 'uploads');
}

/** Yükleme kökü altında bir alt dizin; yoksa oluşturur. */
export function uploadDir(...segments: string[]): string {
  const dir = segments.length ? path.join(uploadRoot(), ...segments) : uploadRoot();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Salt okunur bir dağıtımda dizin önceden hazırlanmış olabilir; yazma
    // denemesi zaten kendi hatasını verir. Burada patlamak, yalnızca yükleme
    // yapmayan uçları da kullanan bir süreci başlatmadan öldürürdü.
  }
  return dir;
}

/**
 * Bir yolun yükleme kökünün İÇİNDE kaldığını doğrular (path traversal).
 * `uploadRoot()` her çağrıda okunur; testler kökü çalışma anında değiştirir.
 */
export function isInsideUploadRoot(candidate: string): boolean {
  const root = path.resolve(uploadRoot()) + path.sep;
  const resolved = path.resolve(candidate);
  return resolved.startsWith(root);
}
