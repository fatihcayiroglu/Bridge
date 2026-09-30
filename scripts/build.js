#!/usr/bin/env node
// scripts/build.js — Bridge Production Builder — Faz 3
// Not: esbuild >=0.25 Safari 14 hedefinde destructuring dönüşümünü reddeder; Safari 14.1+ kullanılır.
// ESM code splitting: esbuild import grafiğini otomatik çözer.
//
// Entry doğrulaması gerçek production ENTRY_POINTS listesinden türetilir;
// böylece analiz modu artık kaldırılmış legacy entry isimlerine bağlı kalmaz.
//
// Kullanım:
//   node scripts/build.js            # production
//   node scripts/build.js --watch    # geliştirme
//   node scripts/build.js --analyze  # boyut raporu

'use strict';

const esbuild = require('esbuild');
const esbuildSvelte = (() => { try { return require('esbuild-svelte'); } catch { return null; } })();

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');

const WATCH   = process.argv.includes('--watch');
const ANALYZE = process.argv.includes('--analyze');
const PROD    = !WATCH && process.env.NODE_ENV !== 'development';
const SRC     = path.join(__dirname, '../client');
const DIST    = path.join(__dirname, '../client/dist');
const JS_SRC  = path.join(SRC, 'js');
const CSS_SRC = path.join(SRC, 'css');

// CDN prefix desteği: CDN_URL env ile tüm asset URL'leri prefixlenir
// Örnek: CDN_URL=https://cdn.example.com → /dist/js/app-XXX.js → https://cdn.example.com/dist/js/app-XXX.js
const PUBLIC_PATH = process.env.CDN_URL ? process.env.CDN_URL.replace(/\/$/, '') + '/' : '/';
if (PUBLIC_PATH !== '/') console.log(`🌐 CDN modu aktif: ${PUBLIC_PATH}`);

// esbuild, splitting ile üretilen chunk import'larını publicPath + dosya adı olarak
// yazar; outdir bilgisini eklemez. PUBLIC_PATH ('/' ya da CDN kökü) tek başına
// verilirse chunk'lar /chunk-XXXX.js olarak istenir ve 404 döner — bundle'ların
// gerçek konumu /dist/js/ olduğu için önek burada tamamlanıyor.
const JS_PUBLIC_PATH = PUBLIC_PATH + 'dist/js/';

fs.mkdirSync(path.join(DIST, 'js'),  { recursive: true });
fs.mkdirSync(path.join(DIST, 'css'), { recursive: true });

function src(...parts) { return path.join(JS_SRC, ...parts); }
function exists(p)     { return fs.existsSync(p); }

// .ts veya .js girişini otomatik çöz — TypeScript tercih edilir
// esbuild TS'i natively destekler; tsc gerekmez.
function entry(name) {
  const ts = src(name.replace(/\.js$/, '.ts'));
  const js = src(name);
  if (exists(ts)) return ts;
  if (exists(js))  return js;
  return null;
}

// ── Entry points ─────────────────────────────────────────────────────────────
// app.ts tüm core modüllerini import eder; esbuild bunu
// otomatik chunk'lara böler (splitting: true, format: 'esm').
const ENTRY_POINTS = [
  // ── UX/P1 — GİRDİ MİMARİSİ ENVANTERİ (ölçüm tabanlı) ──────────────────
  // ÖLÇÜM: hiçbir HTML sayfası ve hiçbir `import()` aşağıdaki eski girdileri
  // TALEP ETMİYORDU. Tüm `<script src>` taraması yalnız iki girdi buldu:
  //     index.html        → js/app.js
  //     marketplace.html  → js/plugin-marketplace-page.js
  // `app.ts` kökenli import kapanışı da şunları DORMANT gösterdi:
  //     federation-ui, federation-modal, threads, slash, webauthn, marketplace,
  //     webrtc-sfu, profile, polls, soundboard, twoFactor, mobile, core/i18n
  // Yani ~80 KB JS derleniyor ve sevk ediliyor ama TARAYICIYA HİÇ GİTMİYOR.
  //
  // KARAR: girdiler kaldırıldı — KAYNAK DURUYOR, SEVK EDİLMİYOR.
  // (Aynı ilke Faz 12'de channel-perms için uygulanmıştı.)
  // Bir modül yeniden canlandırılmak istenirse doğru yol girdiyi geri koymak
  // DEĞİL, onu `app.ts` üzerinden GERÇEK bir kullanıcı girişine bağlamaktır;
  // `webrtc.ts` tam olarak böyle canlandırıldı (Faz 8.3 ses zinciri).
  //
  // DİKKAT: `webrtc.ts` app.ts tarafından import edildiği için ZATEN app.js
  // içindedir; ayrı `webrtc.js` girdisi yalnız yinelenen bir kabuk üretiyordu.
  entry('app.js'),
  entry('plugin-marketplace-page.js'),   // marketplace.html bunu GERÇEKTEN çeker
].filter(Boolean).filter(exists);

// ── CSS build ─────────────────────────────────────────────────────────────────
async function buildCSS() {
  const entryCSS = path.join(CSS_SRC, 'style.css');
  if (!exists(entryCSS)) {
    console.warn('⚠️  client/css/style.css bulunamadı — CSS atlandı.');
    return;
  }
  await esbuild.build({
    entryPoints: [entryCSS],
    bundle:      true,
    minify:      PROD,
    outfile:     path.join(DIST, 'css/style.css'),
    loader:      { '.css': 'css' },
    resolveExtensions: ['.css'],
    logLevel:    'warning',
    metafile:    ANALYZE,
  });

  const tokSrc = path.join(CSS_SRC, 'tokens.css');
  if (exists(tokSrc)) fs.copyFileSync(tokSrc, path.join(DIST, 'css/tokens.css'));

  console.log('✅ CSS' + (PROD ? ' (minified)' : ''));
}

// ── Ana JS build (ESM splitting) ──────────────────────────────────────────────

/**
 * FAZ H1 — ESKI HASH'LI CIKTILARIN TEMIZLENMESI.
 *
 * OLCUM: `dist/js` icinde 83 dosya / 5.36 MB birikmisti; oysa manifest yalnizca
 * 47 girdiye (~681 KB) atifta bulunuyor. Yani 36 dosya / 4.57 MB ESKI
 * BUILD'lerden kalan YETIM hash'li paketlerdi (`app-<eskiHash>.js` gibi).
 *
 * Etkisi dagitimda gercektir: `dist` oldugu gibi servis edilirse canli olanin
 * ~8 kati olu JS diskte durur ve kamuya acik dizinde eski kod birikir.
 *
 * Bu adim YALNIZCA uretilen `dist/js` ciktisini siler — kaynak, yukleme
 * (`server/uploads/**`) veya baska hicbir dizine DOKUNMAZ. Klasor her build'de
 * yeniden yazildigi icin islem geri donusludur.
 */
function cleanJsOutDir() {
  const jsDir = path.join(DIST, 'js');
  if (!fs.existsSync(jsDir)) return 0;
  let removed = 0;
  for (const name of fs.readdirSync(jsDir)) {
    // ÖLÇÜLEN KUSUR (Final20): burada yalnızca `.js` ve `.map` siliniyordu.
    // Ama esbuild BİLEŞEN CSS'ini de AYNI dizine yazıyor
    // (`app-<hash>.css`, `chunk-<hash>.css`). Sonuç: her derleme bir öncekinin
    // CSS parçalarını GERİDE BIRAKIYOR, bunlar birikiyor ve SÜRÜME giriyor.
    // Ölçüldü — uzun süre derlenen bir ağaçta 5 adet başvurulmayan
    // `app-*.css` dosyası vardı; taze bir ağaçta 1 tane.
    // İki sonucu vardı: (a) ölü varlıklar paketleniyordu, (b) arşivin içeriği
    // DERLEME GEÇMİŞİNE bağlı hâle geliyordu, yani yeniden üretilemiyordu.
    if (!/\.(js|css|map)$/.test(name)) continue;   // yalniz uretilen JS/CSS/map
    fs.rmSync(path.join(jsDir, name), { force: true });
    removed++;
  }
  return removed;
}

async function buildJS() {
  const cleaned = cleanJsOutDir();
  if (cleaned) console.log(`🧹 Eski JS ciktisi temizlendi (${cleaned} dosya)`);

  const result = await esbuild.build({
    entryPoints:       ENTRY_POINTS,
    bundle:            true,
    splitting:         true,
    format:            'esm',
    publicPath:        JS_PUBLIC_PATH,
    outdir:            path.join(DIST, 'js'),
    entryNames:        '[name]-[hash]',
    chunkNames:        'chunk-[hash]',
    minify:            PROD,
    minifyWhitespace:  PROD,
    minifyIdentifiers: PROD,
    minifySyntax:      PROD,
    drop:              PROD ? ['debugger'] : [],
    define: {
      'process.env.NODE_ENV': JSON.stringify(PROD ? 'production' : 'development'),
    },
    sourcemap:     WATCH ? 'inline' : (ANALYZE ? 'external' : false),
    target:        ['es2020', 'chrome90', 'firefox90', 'safari14.1'],
    // Non-ASCII text ships as UTF-8, not as `\uXXXX` escapes. esbuild's
    // default ASCII output wrote every Cyrillic/CJK/Turkish character of the
    // locale chunks as 6 bytes (ru.ts: 186.9 KB source → 372.6 KB chunk). Every
    // chunk here is an ES module (`format: 'esm'`), which browsers, Electron and
    // Capacitor always decode as UTF-8, so the output text is unchanged.
    charset:       'utf8',
    logLevel:      'warning',
    legalComments: PROD ? 'none' : 'inline',
    metafile:      true,
    treeShaking:   true,
    // DÜZELTME #7c: v41–v44 re-export'larının doğru çözümlenmesi için
    // resolveExtensions .ts'yi de kapsar (tsc öncesi raw TS kullanılıyorsa)
    resolveExtensions: ['.ts', '.js', '.json', '.svelte'],
    // ══════════════════════════════════════════════════════════════════════
    // BILESEN CSS'I HARICI DOSYAYA YAZILIR — `injected` DEGIL
    // ══════════════════════════════════════════════════════════════════════
    // `css: 'injected'`, her Svelte bileseninin kapsamli stilini CALISMA
    // ZAMANINDA bir <style> ogesi olusturarak sayfaya ekler. Bridge'in KENDI
    // guvenlik basligi bunu ENGELLER (app/createApp.ts):
    //
    //     style-src-elem 'self' 'nonce-<per-request>'
    //
    // Calisma zamaninda uretilen <style> ogesinde nonce YOKTUR, dolayisiyla
    // tarayici onu reddeder. GERCEK TARAYICIDA OLCULDU: sayfada 41 adet
    // <style> ogesi var, hepsinin nonce'u BOS ve `document.styleSheets`
    // yalnizca 2 girdi iceriyor (iki <link> dosyasi). Konsol her biri icin
    // "Applying inline style violates ... style-src-elem" yaziyor.
    //
    // Sonuc yalnizca kozmetik degil: olculen ornekte onboarding sihirbazinin
    // kapat dugmesi 24x24 yerine 4x19, gezinme noktalari 4x4 CSS px oldu
    // (WCAG 2.2 SC 2.5.8 ihlali) ve `position: fixed` uygulanmadigi icin
    // modal ortu 2727 px yuksekliginde bir blok hâline geldi.
    //
    // Birim testleri, `svelte-check` ve kapsam olcumleri bunu GOREMEZ; hata
    // yalnizca gercek basliklarla calisan gercek bir tarayicida ortaya cikar.
    //
    // COZUM: CSP GEVSETILMEZ ('unsafe-inline' EKLENMEZ). Stiller derleme
    // zamaninda toplanip 'self' kaynagindan servis edilen normal bir CSS
    // dosyasi olarak baglanir; boylece katı politika oldugu gibi kalir.
    plugins: esbuildSvelte
      ? [esbuildSvelte({ compilerOptions: { css: 'external', runes: true } })]
      : [],
  });

  // Build sonrası entry doğrulama: doğrulanacak isimleri gerçek build girdilerinden
  // türet. Hard-coded legacy entry listeleri kaldırıldığında bu guard'ın sessizce
  // anlamsızlaşmasını engeller.
  if (ANALYZE && result.metafile) {
    const requiredEntries = ENTRY_POINTS.map(p => path.basename(p, path.extname(p)));
    const outputs = Object.entries(result.metafile.outputs);
    for (const required of requiredEntries) {
      const found = outputs.some(([outputPath, meta]) => {
        const entryPoint = meta.entryPoint && path.basename(meta.entryPoint, path.extname(meta.entryPoint));
        return entryPoint === required || path.basename(outputPath).startsWith(`${required}-`);
      });
      if (!found) {
        throw new Error(`Beklenen production entry chunk bulunamadı: ${required}`);
      }
      console.log(`✅ Entry doğrulandı: ${required}`);
    }
  }

  return result;
}

// ── Service Worker ───────────────────────────────────────────────────────────
// Service workers use a cache-first strategy for navigations.  Merely replacing
// hashed application assets is not enough: an unchanged /sw.js means browsers
// may keep the previous worker (and its cached index) in control.  Compile the
// canonical TypeScript worker for every build and embed the manifest version so
// its update check is deterministic.
async function buildServiceWorker(buildVersion) {
  const workerSrc = path.join(SRC, 'sw.ts');
  if (!exists(workerSrc)) return;

  await esbuild.build({
    entryPoints: [workerSrc],
    outfile:     path.join(SRC, 'sw.js'),
    bundle:      false,
    format:      'iife',
    platform:    'browser',
    target:      ['es2020', 'chrome90', 'firefox90', 'safari14.1'],
    minify:      PROD,
    sourcemap:   false,
    logLevel:    'warning',
    legalComments: PROD ? 'none' : 'inline',
    banner: {
      js: `/* bridge-service-worker-build:${buildVersion} */`,
    },
  });
  console.log('✅ Service Worker' + (PROD ? ' (minified)' : ''));
}

// ── index.html güncelle (type="module") ──────────────────────────────────────
function patchHTML(outputFiles, buildVersion) {
  const htmlSrc = path.join(SRC, 'index.html');
  if (!exists(htmlSrc)) return;

  let html = fs.readFileSync(htmlSrc, 'utf8');

  // Eski script tag'lerini type=module ile değiştir
  // (outputFiles: esbuild metafile outputs)
  const appEntry = outputFiles
    ? Object.keys(outputFiles).find(f => f.includes('/app-') && f.endsWith('.js'))
    : null;

  if (appEntry) {
    const relPath = path.relative(SRC, appEntry).replace(/\\/g, '/');
    const cdnBase = PUBLIC_PATH === '/' ? '' : PUBLIC_PATH;
    const scriptSrc = `${cdnBase}${relPath}`;

    html = html.replace(
      /<script[^>]+src=["'][^"']*app[^"']*["'][^>]*><\/script>/gi,
      `<script type="module" src="${scriptSrc}"></script>`,
    );

    // The versioned worker URL guarantees that a freshly served HTML document
    // asks the browser to install the worker that cached this exact build.
    html = html.replace(
      /serviceWorker\.register\(\s*['"]\/sw\.js(?:\?[^'"]*)?['"]\s*\)/g,
      `serviceWorker.register('/sw.js?v=${encodeURIComponent(String(buildVersion))}')`,
    );

    // ── DERLENMIS BILESEN CSS'I <link> ILE BAGLANIR ─────────────────────
    // `css: 'external'` ile esbuild, Svelte bilesen stillerini entry'nin
    // yanina bir .css dosyasi olarak yazar. Bu dosya 'self' kaynagindan
    // servis edildigi icin CSP'yi gevsetmeden yuklenir.
    const cssOutputs = Object.keys(outputFiles || {})
      .filter(f => f.endsWith('.css'))
      .map(f => `${cdnBase}${path.relative(SRC, f).replace(/\\/g, '/')}`);
    if (cssOutputs.length) {
      const links = cssOutputs
        .map(href => `<link rel="stylesheet" href="${href}">`)
        .join('\n  ');
      html = html.replace('</head>', `  ${links}\n</head>`);
      console.log(`✅ Bilesen CSS baglandi: ${cssOutputs.join(', ')}`);
    } else {
      // Sessiz gerileme olmasin: eklenti CSS uretmediyse bu, bilesen
      // stillerinin TAMAMEN kaybolmasi demektir.
      console.warn('⚠️  Svelte bilesen CSS ciktisi bulunamadi — stiller eksik olabilir.');
    }

    // <link rel="modulepreload"> hint'leri — kritik chunk'ları tarayıcıya önceden bildirir
    if (outputFiles) {
      const criticalChunks = Object.keys(outputFiles)
        .filter(f => f.endsWith('.js') && !f.includes('chunk-'))
        .slice(0, 6) // İlk 6 entry point
        .map(f => {
          const rel = path.relative(SRC, f).replace(/\\/g, '/');
          return `<link rel="modulepreload" href="${cdnBase}${rel}">`;
        });
      if (criticalChunks.length) {
        html = html.replace('</head>', criticalChunks.join('\n  ') + '\n</head>');
      }
    }

    fs.writeFileSync(htmlSrc.replace('index.html', 'index.dist.html'), html);
    if (PUBLIC_PATH !== '/') {
      console.log(`✅ HTML patched — CDN prefix: ${PUBLIC_PATH}`);
    }
  }

  patchSecondaryHTML('marketplace.html', 'plugin-marketplace-page', outputFiles);
}

// ── IKINCIL HTML GIRDILERI ───────────────────────────────────────────────────
// ÖLÇÜLEN KUSUR: `/marketplace`, `marketplace.html`i OLDUĞU GİBİ servis
// ediyordu ve o dosya `js/plugin-marketplace-page.js`e bakıyordu. Build ise
// yalnızca HASH'Lİ adı üretir (`plugin-marketplace-page-XXXXXXXX.js`). Canlı
// sunucuda ölçüldü:
//
//     GET /marketplace                      -> 200
//     GET /js/plugin-marketplace-page.js     -> 404   ← sayfanın TEK script'i
//
// Yani eklenti pazarı sayfası HİÇ JavaScript yüklemiyordu; boş bir kabuk
// dönüyordu. `index.html` için bu sorun `index.dist.html` üretilerek zaten
// çözülmüştü — ikincil giriş sayfası aynı işlemden geçmiyordu.
function patchSecondaryHTML(fileName, entryBaseName, outputFiles) {
  const htmlSrc = path.join(SRC, fileName);
  if (!exists(htmlSrc) || !outputFiles) return;

  const entry = Object.keys(outputFiles)
    .find(f => f.endsWith('.js') && path.basename(f).startsWith(`${entryBaseName}-`));
  if (!entry) {
    console.warn(`⚠️  ${fileName}: "${entryBaseName}" çıktısı bulunamadı — sayfa script'siz kalır.`);
    return;
  }

  const cdnBase = PUBLIC_PATH === '/' ? '' : PUBLIC_PATH;
  const rel     = path.relative(SRC, entry).replace(/\\/g, '/');
  let html      = fs.readFileSync(htmlSrc, 'utf8');

  html = html.replace(
    new RegExp(`<script[^>]+src=["'][^"']*${entryBaseName}[^"']*["'][^>]*></script>`, 'gi'),
    `<script type="module" src="${cdnBase}${rel}"></script>`,
  );

  const cssOutputs = Object.keys(outputFiles)
    .filter(f => f.endsWith('.css'))
    .map(f => `${cdnBase}${path.relative(SRC, f).replace(/\\/g, '/')}`);
  if (cssOutputs.length) {
    const links = cssOutputs
      .map(href => `<link rel="stylesheet" href="${href}">`)
      .join('\n  ');
    html = html.replace('</head>', `  ${links}\n</head>`);
  }

  fs.writeFileSync(htmlSrc.replace('.html', '.dist.html'), html);
  console.log(`✅ ${fileName} → ${fileName.replace('.html', '.dist.html')} (${path.basename(entry)})`);
}

// ── Ana akış ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🔨 Bridge Build — ${PROD ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  console.log(`   Entry'ler: ${ENTRY_POINTS.length} dosya`);

  const [jsResult] = await Promise.all([buildJS(), buildCSS()]);

  if (jsResult?.metafile) {
    // ── meta.json HER BUILD'DE YAZILIR ───────────────────────────────────
    // Bu dosya yalnızca `--analyze` ile yazılıyordu; oysa bütçe kapısı
    // (`check-bundle-budget.js`) ilk-indirme kapanışını HESAPLAMAK için import
    // grafiğine ihtiyaç duyar. `build:ci` analyze'siz koştuğu için kapı grafiği
    // hiç göremiyor, chunk/entry alt bütçeleri de SESSİZCE hiç çalışmıyordu.
    // `metafile: true` zaten koşulsuz; yazmanın ek maliyeti yok.
    fs.writeFileSync(
      path.join(DIST, 'meta.json'),
      JSON.stringify(jsResult.metafile, null, 2),
    );
    if (ANALYZE) {
      console.log('📊 meta.json oluşturuldu — esbuild.github.io/bundle-size-analyzer ile analiz edilebilir.');
    }
    // ── asset-manifest.json: Service Worker'ın hash'li dosya isimlerini bulması için ──
    // SW bu dosyayı install aşamasında fetch eder; STATIC_ASSETS listesini dinamik olarak oluşturur.
    const manifestEntries = Object.keys(jsResult.metafile.outputs)
      .filter(f => f.endsWith('.js') || f.endsWith('.css'))
      .map(f => '/' + path.relative(path.join(__dirname, '../client'), f).replace(/\\/g, '/'));
    // ── SÜRÜM DAMGASI: ZAMAN DEĞİL, İÇERİK ───────────────────────────────
    // ÖLÇÜLEN KUSUR (Final20): `buildVersion = Date.now()` idi ve üç yere
    // gömülüyordu — `client/sw.js` banner'ı, `index.html` içindeki
    // `serviceWorker.register('/sw.js?v=…')` ve `asset-manifest.json`.
    // Sonucu iki kat kötüydü:
    //
    //   1. YENİDEN ÜRETİLEBİLİRLİK: aynı kaynak iki kez derlendiğinde
    //      `client/sw.js` FARKLI baytlar veriyordu. Yani "aynı kaynak → aynı
    //      arşiv" zinciri paketleyicide değil, DERLEMEDE kopuyordu.
    //      (Ölçüldü: sadece banner satırı farklı —
    //       `…build:1789053526301` vs `…build:1789089667644`.)
    //   2. DAVRANIŞ: Service Worker sürümü her derlemede değişiyordu; hiçbir
    //      varlık değişmese bile istemcilerde SW yeniden kuruluyor ve önbellek
    //      boşuna geçersizleşiyordu.
    //
    // Damga artık ÇIKTI VARLIKLARININ ADLARINDAN türetilir. esbuild bu adlara
    // içerik hash'i koyduğu için: varlıklar aynıysa damga aynı, bir varlık
    // değiştiyse damga değişir — istenen davranış tam olarak budur.
    //
    // `SOURCE_DATE_EPOCH` (yeniden üretilebilir derleme standardı) verilmişse
    // ona saygı gösterilir.
    const buildVersion = (() => {
      const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH);
      if (Number.isFinite(sourceDateEpoch) && sourceDateEpoch > 0) return sourceDateEpoch * 1000;
      const fingerprint = require('crypto')
        .createHash('sha256')
        .update(manifestEntries.slice().sort().join('|'))
        .digest('hex')
        .slice(0, 12);
      return fingerprint;
    })();
    const assetManifest = {
      version:  buildVersion,
      assets:   ['/', '/css/style.css', '/css/tokens.css', ...manifestEntries],
    };
    fs.writeFileSync(
      path.join(DIST, 'asset-manifest.json'),
      JSON.stringify(assetManifest, null, 2),
    );
    console.log(`📋 asset-manifest.json yazıldı (${manifestEntries.length} JS dosyası)`);
    await buildServiceWorker(buildVersion);
    patchHTML(jsResult.metafile?.outputs, buildVersion);
  }

  const outputs = jsResult?.metafile?.outputs ?? {};
  const totalSize = Object.values(outputs)
    .filter(o => o.bytes)
    .reduce((sum, o) => sum + o.bytes, 0);
  console.log(`✅ JS (${(totalSize / 1024).toFixed(1)} KB total, ${PROD ? 'minified' : 'dev'})`);

  // --analyze: terminalde top-10 chunk özeti
  if (ANALYZE) {
    const sorted = Object.entries(outputs)
      .filter(([f, o]) => f.endsWith('.js') && o.bytes)
      .sort(([, a], [, b]) => b.bytes - a.bytes)
      .slice(0, 10);
    console.log('\n📊 Top chunks:');
    for (const [file, meta] of sorted) {
      const kb   = (meta.bytes / 1024).toFixed(1).padStart(8);
      const name = path.basename(file).slice(0, 40).padEnd(42);
      const inputs = Object.keys(meta.inputs || {}).length;
      console.log(`  ${kb} KB  ${name} (${inputs} modules)`);
    }
    console.log('');
  }
}

main().catch(err => {
  console.error('❌ Build hatası:', err.message);
  process.exit(1);
});
