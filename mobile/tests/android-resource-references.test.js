// mobile/tests/android-resource-references.test.js
//
// ════════════════════════════════════════════════════════════════════════════
// ANDROID MANİFEST — KAYNAK ATIFLARI GERÇEKTEN ÇÖZÜLÜYOR MU?
// ════════════════════════════════════════════════════════════════════════════
//
// ── KAPATILAN GERÇEK KUSUR (Final21, Faz 3) ────────────────────────────────
// `AndroidManifest.xml` iki kaynağa atıfta bulunuyordu:
//
//     @drawable/ic_notification   (FCM varsayılan bildirim ikonu)
//     @color/bridge_blue          (FCM varsayılan bildirim rengi)
//
// ve İKİSİ DE depoda hiç tanımlı değildi. `mobile/BUILD.md`de belgelenen yol
// izlendiğinde (`npx cap add android` + bu overlay) derleme şununla duruyordu:
//
//     AAPT: error: resource drawable/ic_notification not found
//     AAPT: error: resource color/bridge_blue not found
//
// Yani Android uygulaması, KENDİ belgelenen yordamıyla DERLENEMİYORDU — ve
// bunu hiçbir şey ölçmüyordu, çünkü native derleme CI'da hiç koşmuyor.
//
// Bu dosya o kör noktayı kalıcı olarak kapatır: manifest'teki HER kaynak
// atıfı ya overlay'de bulunmalı ya da Capacitor iskelesinin ürettiği bilinen
// kümede olmalıdır. Yeni bir atıf eklenip kaynağı unutulursa test DÜŞER —
// gradle'ı hiç çalıştırmadan, saniyeler içinde.
//
// ── KAPSAM DÜRÜSTLÜĞÜ ───────────────────────────────────────────────────────
// Bu test AAPT'nin YERİNE GEÇMEZ. Yalnızca "atıf var ama kaynak yok" sınıfını
// yakalar. Gerçek derleme kanıtı Faz 3'ün emülatör koşumundadır.

'use strict';

const fs = require('fs');
const path = require('path');

const ANDROID_APP = path.join(__dirname, '..', 'android', 'app', 'src');
const MAIN = path.join(ANDROID_APP, 'main');
const MANIFESTS = [
  path.join(MAIN, 'AndroidManifest.xml'),
  path.join(ANDROID_APP, 'debug', 'AndroidManifest.xml'),
];

/**
 * `npx cap add android` tarafından ÜRETİLEN kaynaklar.
 *
 * Bunlar depoda YOKTUR ve olmamalıdır: iskele her makinede yeniden üretilir
 * (`mobile/BUILD.md`). Bu yüzden beyaz listede tutulurlar — ama liste AÇIK
 * yazılıdır, "her şeyi kabul et" değildir.
 */
const CAPACITOR_SCAFFOLD = new Set([
  'mipmap/ic_launcher',
  'mipmap/ic_launcher_round',
  'style/AppTheme',
  'style/AppTheme.NoActionBarLaunch',
]);

/** Overlay'de gerçekten dosyası olan kaynakları toplar. */
function overlayResources() {
  const found = new Set();
  const resRoot = path.join(MAIN, 'res');
  if (!fs.existsSync(resRoot)) return found;

  for (const dir of fs.readdirSync(resRoot)) {
    const abs = path.join(resRoot, dir);
    if (!fs.statSync(abs).isDirectory()) continue;
    // `values-tr` gibi niteleyicileri temel türe indir: `values`
    const kind = dir.split('-')[0];

    for (const file of fs.readdirSync(abs)) {
      const full = path.join(abs, file);
      if (!fs.statSync(full).isFile()) continue;

      if (kind === 'values') {
        // values/*.xml İÇİNDEKİ adlar kaynaktır, dosya adı değil.
        const xml = fs.readFileSync(full, 'utf8');
        for (const m of xml.matchAll(/<(string|color|dimen|bool|integer|style)\s+name="([^"]+)"/g)) {
          found.add(`${m[1]}/${m[2]}`);
        }
      } else {
        found.add(`${kind}/${path.parse(file).name}`);
      }
    }
  }
  return found;
}

// ════════════════════════════════════════════════════════════════════════════
// XML BİÇİM DOĞRULUĞU — AAPT'den ÖNCE
// ════════════════════════════════════════════════════════════════════════════
// Final21 sırasında yazılan bir yorum satırı `--brand-h` içeriyordu. XML 1.0
// §2.5 yorumların içinde `--` dizisini YASAKLAR; AAPT derlemeyi şununla
// durdurdu:
//
//     Error: The string "--" is not permitted within comments.
//
// Ders: iyi niyetli bir açıklama bile native derlemeyi kırabiliyor ve bunu
// ancak dakikalar süren bir Gradle koşumu söylüyordu. Bu blok aynı sınıfı
// saniyeler içinde yakalar.
describe('Android XML kaynakları — biçim doğruluğu', () => {
  /** `res/` ve manifest altındaki tüm XML dosyaları. */
  function xmlFiles() {
    const out = [];
    const walk = (dir) => {
      if (!fs.existsSync(dir)) return;
      for (const entry of fs.readdirSync(dir)) {
        const abs = path.join(dir, entry);
        const stat = fs.statSync(abs);
        if (stat.isDirectory()) walk(abs);
        else if (entry.endsWith('.xml')) out.push(abs);
      }
    };
    walk(path.join(__dirname, '..', 'android'));
    return out;
  }

  const files = xmlFiles();

  it('taranacak XML dosyası bulunur (pozitif kontrol)', () => {
    expect(files.length).toBeGreaterThan(3);
  });

  // KAPSAM DÜRÜSTLÜĞÜ: bu bir XML AYRIŞTIRICISI DEĞİLDİR. Node'da yerleşik
  // XML ayrıştırıcı yok ve yalnızca bu kontrol için üretim bağımlılığı
  // eklemek doğru olmazdı. Yakalanan sınıf, GERÇEKTEN derlemeyi kıran
  // sınıftır: yorum içinde `--`. Tam biçim doğrulaması AAPT'nin işidir ve
  // Faz 3'ün emülatör derlemesinde koşar.
  it('hiçbir XML yorumu "--" içermez', () => {
    const bad = [];
    for (const file of files) {
      const xml = fs.readFileSync(file, 'utf8');
      const rel = path
        .relative(path.join(__dirname, '..'), file)
        .split(path.sep)
        .join('/');

      for (const match of xml.matchAll(/<!--([\s\S]*?)-->/g)) {
        if (match[1].includes('--')) bad.push(`${rel}: yorum icinde "--"`);
      }
    }
    expect({ bad }).toEqual({ bad: [] });
  });
});

describe('AndroidManifest — kaynak atıfları', () => {
  const available = overlayResources();

  it('overlay en azından kendi kaynaklarını tanımlar', () => {
    // Pozitif kontrol: tarayıcı gerçekten bir şey buluyor mu?
    // Bulmuyorsa aşağıdaki asıl test boş kümeyle sahte geçerdi.
    expect(available.has('string/app_name')).toBe(true);
  });

  for (const manifestPath of MANIFESTS) {
    const label = path.relative(path.join(__dirname, '..'), manifestPath).replace(/\\/g, '/');

    it(`${label} — her atıf çözülür`, () => {
      if (!fs.existsSync(manifestPath)) {
        throw new Error(`manifest bulunamadı: ${manifestPath}`);
      }
      const xml = fs.readFileSync(manifestPath, 'utf8').replace(/<!--[\s\S]*?-->/g, ' ');

      const referenced = [...xml.matchAll(/"@([a-z]+)\/([A-Za-z0-9_.]+)"/g)]
        .map((m) => `${m[1]}/${m[2]}`);

      const missing = [...new Set(referenced)].filter(
        (ref) => !available.has(ref) && !CAPACITOR_SCAFFOLD.has(ref),
      );

      expect({ missing }).toEqual({ missing: [] });
    });
  }
});
