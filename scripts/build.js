#!/usr/bin/env node
// scripts/build.js — Bridge Production Builder — Faz 3
// Not: esbuild >=0.25 Safari 14 hedefinde destructuring dönüşümünü reddeder; Safari 14.1+ kullanılır.
// ESM code splitting: esbuild import grafiğini otomatik çözer.
//
// DÜZELTME #7: federation-ui.js ve core/go-live.js
//              entry point listesine eklendi. Eskiden bundle'a girmiyordu.
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
  entry('app.js'),
  // Lazy-loaded pages
  entry('admin.js'),
  entry('discover.js'),
  entry('federation-modal.js'),
  // DÜZELTME #7a: federation-ui.js eksikti — eklendi
  entry('federation-ui.js'),
  entry('threads.js'),
  entry('slash.js'),
  entry('profile.js'),
  entry('polls.js'),
  entry('soundboard.js'),
  entry('marketplace.js'),
  entry('plugin-marketplace-page.js'),
  entry('twoFactor.js'),
  entry('webauthn.js'),
  entry('mobile.js'),
  entry('webrtc.js'),
  entry('webrtc-sfu.js'),
// Sprint 30: v41–v44 klasörleri kaldırıldı — dosyalar core/ altına taşındı.
  entry('core/go-live.ts'),
  // Sprint 28: channel-perms-modal split — 4 modül (yükleme sırası önemli)
  entry('core/channel-perms/modal-state.ts'),
  entry('core/channel-perms/modal-actions.ts'),
  entry('core/channel-perms/modal-audit-sync.ts'),
  entry('core/channel-perms/modal-core.ts'),
  // Sprint 49: JS → TS geçişleri
  entry('core/mention-autocomplete.ts'),
  entry('core/messages/reactions.ts'),
  entry('core/messages/scroll.ts'),

  // ── Sprint 50: Kalan 25 JS → TS tam dönüşümü ──────────────────────────────
  // Tree-shaking aktif — kullanılmayan export'lar otomatik atılır.
  // esbuild bu dosyaları import grafiğiyle birleştirir; yinelenen kod olmaz.
  entry('core/voice.ts'),
  entry('core/web-push.ts'),
  entry('core/offline-banner.ts'),
  entry('core/analytics.ts'),
  entry('core/mobile.ts'),
  entry('core/virtual-scroll.ts'),
  entry('core/i18n.ts'),
  entry('core/canvas.ts'),
  entry('core/ip-ban.ts'),
  entry('core/styles.ts'),
  entry('core/partials.ts'),
  entry('core/stage.ts'),
  entry('core/user-connections.ts'),
  entry('core/channel-stage.ts'),
  entry('core/discover.ts'),
  entry('core/mobile-ux.ts'),
  entry('core/emoji-picker.ts'),
  entry('core/calendar-picker.ts'),
  entry('core/clyde.ts'),
  entry('core/group-dm-core.ts'),
  entry('core/onboarding-tour.ts'),
  entry('core/server-ui.ts'),
  entry('core/bot-marketplace.ts'),
  entry('core/channel-perms/channel-perms-svelte.ts'),
  entry('core/messages/loader.ts'),
  entry('core/messages/virtual-scroll.ts'),
  // ── Sprint 92: Yeni modüller ──────────────────────────────────────────────────
  entry('core/desktop-voice-bar.ts'),
  entry('core/boost-ui.ts'),               // Sprint 93
  entry('core/spotify-widget.ts'),         // Sprint 93
  entry('core/e2ee-toggle.ts'),            // Sprint 93
  entry('core/analytics-dashboard.ts'),    // Sprint 94
  entry('core/announcement-ui.ts'),        // Sprint 94
  entry('core/settings-modal-voice.ts'),
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
async function buildJS() {
  const result = await esbuild.build({
    entryPoints:       ENTRY_POINTS,
    bundle:            true,
    splitting:         true,
    format:            'esm',
    publicPath:        PUBLIC_PATH,
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
    logLevel:      'warning',
    legalComments: PROD ? 'none' : 'inline',
    metafile:      true,
    treeShaking:   true,
    // DÜZELTME #7c: v41–v44 re-export'larının doğru çözümlenmesi için
    // resolveExtensions .ts'yi de kapsar (tsc öncesi raw TS kullanılıyorsa)
    resolveExtensions: ['.ts', '.js', '.json', '.svelte'],
    plugins: esbuildSvelte
      ? [esbuildSvelte({ compilerOptions: { css: 'injected', runes: true } })]
      : [],
  });

  // DÜZELTME #7d: Build sonrası entry doğrulama
  if (ANALYZE && result.metafile) {
    const requiredEntries = ['federation-ui', 'go-live'];
    const outputs = Object.keys(result.metafile.outputs);
    for (const required of requiredEntries) {
      const found = outputs.some(o => path.basename(o).startsWith(required));
      if (!found) {
        console.warn(`⚠️  Beklenen entry chunk bulunamadı: ${required}`);
      } else {
        console.log(`✅ Entry doğrulandı: ${required}`);
      }
    }
  }

  return result;
}

// ── index.html güncelle (type="module") ──────────────────────────────────────
function patchHTML(outputFiles) {
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
}

// ── Ana akış ─────────────────────────────────────────────────────────────────
async function main() {
  console.log(`🔨 Bridge Build — ${PROD ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  console.log(`   Entry'ler: ${ENTRY_POINTS.length} dosya`);

  const [jsResult] = await Promise.all([buildJS(), buildCSS()]);

  if (jsResult?.metafile) {
    if (ANALYZE) {
      fs.writeFileSync(
        path.join(DIST, 'meta.json'),
        JSON.stringify(jsResult.metafile, null, 2),
      );
      console.log('📊 meta.json oluşturuldu — esbuild.github.io/bundle-size-analyzer ile analiz edilebilir.');
    }
    patchHTML(jsResult.metafile?.outputs);

    // ── asset-manifest.json: Service Worker'ın hash'li dosya isimlerini bulması için ──
    // SW bu dosyayı install aşamasında fetch eder; STATIC_ASSETS listesini dinamik olarak oluşturur.
    const manifestEntries = Object.keys(jsResult.metafile.outputs)
      .filter(f => f.endsWith('.js'))
      .map(f => '/' + path.relative(path.join(__dirname, '../client'), f).replace(/\\/g, '/'));
    const assetManifest = {
      version:  Date.now(),
      assets:   ['/', '/css/style.css', '/css/tokens.css', ...manifestEntries],
    };
    fs.writeFileSync(
      path.join(DIST, 'asset-manifest.json'),
      JSON.stringify(assetManifest, null, 2),
    );
    console.log(`📋 asset-manifest.json yazıldı (${manifestEntries.length} JS dosyası)`);
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
