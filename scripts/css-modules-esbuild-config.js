// scripts/build.js — CSS Modules Aktivasyonu için Değişiklikler
//
// MEVCUT DURUM:
//   client/css/modules/*.css → style.css entry üzerinden @import ile bundle ediliyor
//   Scoped class adı yok, global namespace
//
// HEDEF:
//   JS/TS bileşenlerinden `import styles from './foo.module.css'` ile
//   scoped class adları (örn. styles.container) kullanılabilsin
//
// NOT: Bridge Vanilla JS + esbuild kullanıyor (Vite yok).
//      "CSS Modules" burada iki farklı şey ifade edebilir:
//        A) esbuild'in built-in cssModulesEnabled (v0.25+) — local class scoping
//        B) Mevcut client/css/modules/*.css dosyaları — bunlar zaten @import ile bundle ediliyor,
//           CSS Modules spec'i DEĞİL, sadece dosya organizasyonu
//      Bu config Seçenek A'yı aktive eder.

'use strict';

const esbuild = require('esbuild');
const fs      = require('fs');
const path    = require('path');

const PROD    = process.env.NODE_ENV === 'production';
const SRC     = path.join(__dirname, '../client');
const DIST    = path.join(__dirname, '../client/dist');
const CSS_SRC = path.join(SRC, 'css');
const JS_SRC  = path.join(SRC, 'js');

fs.mkdirSync(path.join(DIST, 'js'),  { recursive: true });
fs.mkdirSync(path.join(DIST, 'css'), { recursive: true });

// ── 1. Global CSS bundle (değişmedi) ─────────────────────────
// client/css/style.css → dist/css/style.css
// client/css/modules/*.css bu entry üzerinden @import ile gelir
// Bunlar CSS Modules DEĞİL — global stylesheet olarak kalır
async function buildGlobalCSS() {
  const entryCSS = path.join(CSS_SRC, 'style.css');
  if (!fs.existsSync(entryCSS)) {
    console.warn('⚠️  client/css/style.css bulunamadı — global CSS atlandı.');
    return;
  }

  await esbuild.build({
    entryPoints: [entryCSS],
    bundle:      true,
    minify:      PROD,
    outfile:     path.join(DIST, 'css/style.css'),
    loader:      { '.css': 'css' },
    logLevel:    'warning',
  });

  console.log('✅ Global CSS bundle: dist/css/style.css');
}

// ── 2. JS chunks — CSS Modules aktif ─────────────────────────
// *.module.css dosyaları JS'ten import edildiğinde:
//   import styles from './button.module.css'
//   → styles.primary  ===  "button_primary_xK9mR"  (scoped)
//   → <button class={styles.primary}>
//
// esbuild v0.21+ ile cssModulesEnabled kullanılır.
// Üretilen CSS otomatik olarak JS bundle'ına inject edilir (loader: css injected)
// VEYA ayrı bir .css dosyası olarak çıkarılır (tercih aşağıda).

const CSS_MODULES_CONFIG = {
  // Naming pattern: [dosyaadı]_[localName]_[hash5]
  // Örn: button.module.css içindeki .primary → button_primary_xK9mR
  pattern: '[local]_[hash]',
};

async function buildJSChunks() {
  // Örnek: sadece yeni component dosyaları için CSS Modules kullan
  // Mevcut chunk-boot, chunk-core vb. DEĞİŞMEZ — onlar global CSS'e bağımlı

  // Yeni Vue/component-tabanlı dosyalar için ayrı bir entry eklenebilir:
  const componentEntry = path.join(JS_SRC, 'components/index.js');
  if (!fs.existsSync(componentEntry)) {
    console.log('ℹ️  components/index.js yok — CSS Modules adımı atlandı.');
    return;
  }

  await esbuild.build({
    entryPoints:  [componentEntry],
    bundle:       true,
    minify:       PROD,
    outfile:      path.join(DIST, 'js/chunk-components.js'),
    loader: {
      '.js':          'js',
      '.ts':          'ts',
      // *.module.css → CSS Modules (scoped)
      '.module.css':  'local-css',
      // *.css → normal CSS (global, inject)
      '.css':         'css',
    },
    // CSS çıktısı JS'in yanına ayrı dosya olarak: chunk-components.css
    // Bunu <link> ile yükle VEYA inject için 'injected' kullan
    // 'linked' = ayrı dosya (tercih edilen — cache friendly)
    cssChunks:    true,
    logLevel:     'warning',
  });

  console.log('✅ Component chunk: dist/js/chunk-components.js + chunk-components.css');
}

// ── 3. Kademeli geçiş stratejisi ──────────────────────────────
// AŞAMA 1 (Şu an): Yeni *.module.css dosyaları components/ altında
//   → Mevcut client/css/modules/*.css'e dokunma
//   → Sadece yeni bileşenler CSS Modules kullanır
//
// AŞAMA 2 (Sprint 18+): Mevcut global CSS'i bileşenlere taşı
//   → settings.module.css, messages.module.css vb.
//   → client/css/modules/ klasörü küçülür
//
// AŞAMA 3 (Sprint 20+): style.css entry sadece reset + tokens içerir
//   → Tam scoped CSS

// ── 4. index.html güncelleme notu ─────────────────────────────
// CSS Modules çıktısı (linked mod) HTML'e eklenmeli:
//
//   <!-- Mevcut global CSS (değişmedi) -->
//   <link rel="stylesheet" href="/dist/css/style.css">
//
//   <!-- Yeni: component chunk CSS (esbuild otomatik üretir) -->
//   <link rel="stylesheet" href="/dist/js/chunk-components.css">
//
// NOT: esbuild cssChunks:true ile üretilen dosya adı tahmin edilemez.
// Bunun yerine metafile + manifest kullanmak daha güvenli:

async function buildWithManifest() {
  const result = await esbuild.build({
    entryPoints: [path.join(JS_SRC, 'components/index.js')],
    bundle:      true,
    minify:      PROD,
    outdir:      path.join(DIST, 'js'),
    loader: {
      '.module.css': 'local-css',
      '.css':        'css',
      '.js':         'js',
      '.ts':         'ts',
    },
    metafile:    true,
    logLevel:    'warning',
  });

  // Manifest yaz → server veya index.html generator okuyabilir
  fs.writeFileSync(
    path.join(DIST, 'manifest.json'),
    JSON.stringify(result.metafile.outputs, null, 2)
  );

  console.log('✅ Manifest: dist/manifest.json');
}

// ── 5. TypeScript tip tanımları (.module.css.d.ts) ────────────
// Eğer TypeScript import styles from './foo.module.css' derlerse:
//   "Cannot find module './foo.module.css'"
// Çözüm A: Global declare (hızlı, kaba)
//   client/types/css-modules.d.ts:
//     declare module '*.module.css' {
//       const styles: { [className: string]: string };
//       export default styles;
//     }
//
// Çözüm B: typed-css-modules (otomatik .d.ts üretimi — önerilir)
//   npx tcm client/js/components --watch
//   → Her *.module.css için *.module.css.d.ts üretir
//   → tsconfig.json include'a 'client/js/**/*.d.ts' ekle

// ── Çalıştırma ────────────────────────────────────────────────
(async () => {
  try {
    await buildGlobalCSS();
    await buildJSChunks();   // components/index.js varsa
    console.log('\n🎉 Build tamamlandı.');
  } catch (err) {
    console.error('❌ Build hatası:', err.message);
    process.exit(1);
  }
})();


// ══════════════════════════════════════════════════════════════
// EK: Mevcut scripts/build.js'e minimum değişiklik (patch)
// ══════════════════════════════════════════════════════════════
//
// Mevcut buildJSBundle() içindeki esbuild.build() çağrısına
// sadece şu satırı eklemek yeterli (diğer her şey değişmez):
//
//   loader: {
//     ...mevcutLoader,
//     '.module.css': 'local-css',   // ← YENİ SATIR
//   },
//
// Bu sayede client/js/components/Button.js şunu yapabilir:
//   import styles from './Button.module.css';
//   el.className = styles.container;
//
// Mevcut global CSS pipeline'ı (style.css → dist/css/style.css)
// HİÇ DEĞİŞMEZ.
