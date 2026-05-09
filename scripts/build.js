#!/usr/bin/env node
// scripts/build.js — Bridge Production Builder — Faz 3
// ESM code splitting: esbuild import grafiğini otomatik çözer.
// Manuel CHUNKS dizisi ve buildChunk() kaldırıldı.
// SPLITTING_ACTIVE guard kaldırıldı.
//
// Kullanım:
//   node scripts/build.js            # production
//   node scripts/build.js --watch    # geliştirme
//   node scripts/build.js --analyze  # boyut raporu

'use strict';

const esbuild = require('esbuild');
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

// ── Dizin hazırlığı ───────────────────────────────────────────
fs.mkdirSync(path.join(DIST, 'js'),  { recursive: true });
fs.mkdirSync(path.join(DIST, 'css'), { recursive: true });

function src(...parts) { return path.join(JS_SRC, ...parts); }
function exists(p)     { return fs.existsSync(p); }

// ── Entry points — esbuild import grafiğini kendisi çözer ────
// app.js tüm core modüllerini import eder; esbuild bunu
// otomatik chunk'lara böler (splitting: true, format: 'esm').
const ENTRY_POINTS = [
  src('app.js'),
  // Lazy-loaded pages — ayrı entry olarak tanımlanır,
  // böylece esbuild ortak bağımlılıkları shared chunk'a alır.
  src('admin.js'),
  src('discover.js'),
  src('federation-modal.js'),
  src('federation-integrations.js'),
  src('threads.js'),
  src('slash.js'),
  src('profile.js'),
  src('polls.js'),
  src('soundboard.js'),
  src('marketplace.js'),
  src('plugin-marketplace-page.js'),
  src('twoFactor.js'),
  src('webauthn.js'),
  src('mobile.js'),
  src('webrtc.js'),
  src('webrtc-sfu.js'),
].filter(exists);

// ── CSS build ─────────────────────────────────────────────────
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

// ── Ana JS build (ESM splitting) ──────────────────────────────
async function buildJS() {
  const result = await esbuild.build({
    entryPoints:       ENTRY_POINTS,
    bundle:            true,
    splitting:         true,   // esbuild otomatik shared chunk üretir
    format:            'esm',
    outdir:            path.join(DIST, 'js'),
    entryNames:        '[name]-[hash]',  // content hash — cache busting
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
    target:        ['es2020', 'chrome90', 'firefox90', 'safari14'],
    logLevel:      'warning',
    legalComments: PROD ? 'none' : 'inline',
    metafile:      true,
    treeShaking:   true,
  });

  return result;
}

// ── index.html güncelle (type="module") ──────────────────────
function patchHTML(outputFiles) {
  const htmlSrc = path.join(SRC, 'index.html');
  if (!exists(htmlSrc)) return;

  let html = fs.readFileSync(htmlSrc, 'utf8');

  // Eski DEV/PROD dynamic loader script bloğunu sil
  html = html.replace(
    /\s*<script>\s*\(function\(\)\s*\{[\s\S]*?PROD_CHUNKS[\s\S]*?\}\)\(\);\s*<\/script>/,
    ''
  );
  // Kalan eski defer script taglarını da temizle
  html = html.replace(/\s*<script src="js\/[^"]*" defer><\/script>/g, '');

  // app entry'nin hash'li adını bul
  const appEntry = outputFiles.find(f =>
    f.includes('/js/app-') && f.endsWith('.js')
  );
  if (!appEntry) {
    console.warn('⚠️  app entry output bulunamadı — HTML script inject atlandı.');
    return;
  }

  const appRelPath = 'js/' + path.basename(appEntry);
  const moduleTag  = `  <script type="module" src="${appRelPath}"></script>`;

  // </body> öncesine ekle
  html = html.replace('</body>', moduleTag + '\n</body>');

  fs.writeFileSync(path.join(DIST, 'index.html'), html);
  console.log(`✅ index.html güncellendi → ${appRelPath}`);
}

// ── sw.js — hash'li isimler için güncelle ────────────────────
function injectSW(outputFiles) {
  const swSrc = path.join(SRC, 'sw.js');
  if (!exists(swSrc)) return;

  const assets = ['/', '/css/style.css'];

  // dist/js/ içindeki tüm .js dosyaları SW listesine girer
  for (const f of outputFiles) {
    const rel = '/' + path.relative(DIST, f).replace(/\\/g, '/');
    assets.push(rel);
  }

  // Cache version: tüm dosyaların içerik hash'i
  const hash = crypto.createHash('sha1');
  for (const a of assets) {
    const fp = path.join(DIST, a.replace(/^\//, ''));
    if (exists(fp)) hash.update(fs.readFileSync(fp));
  }
  const version = 'bridge-' + hash.digest('hex').slice(0, 8);

  let sw = fs.readFileSync(swSrc, 'utf8');
  sw = sw.replace(/const CACHE_VERSION = '[^']*';/, `const CACHE_VERSION = '${version}';`);
  sw = sw.replace(
    /const STATIC_ASSETS = \[[\s\S]*?\];/,
    `const STATIC_ASSETS = ${JSON.stringify([...new Set(assets)].sort(), null, 2)};`
  );

  fs.writeFileSync(path.join(DIST, 'sw.js'), sw);
  console.log(`✅ sw.js → cache version: ${version} (${assets.length} asset)`);
}

// ── Statik kopyalar ───────────────────────────────────────────
function copyStatic() {
  const statics = ['manifest.json', 'teams.html'];
  for (const f of statics) {
    const p = path.join(SRC, f);
    if (exists(p)) fs.copyFileSync(p, path.join(DIST, f));
  }
  console.log('✅ Statik dosyalar kopyalandı');
}

// ── Boyut raporu ──────────────────────────────────────────────
function sizeReport(outputFiles) {
  const kb    = n => (n / 1024).toFixed(1) + ' KB';
  let   total = 0;
  console.log('\n📦 Output dosyaları (JS):');
  for (const f of outputFiles.sort()) {
    if (!f.endsWith('.js')) continue;
    const size = fs.statSync(f).size;
    total += size;
    const name = path.relative(DIST, f);
    const bar  = '█'.repeat(Math.max(1, Math.round(size / 8192)));
    console.log(`   ${name.padEnd(40)}  ${kb(size).padStart(10)}  ${bar}`);
  }
  const cssPath = path.join(DIST, 'css/style.css');
  const cssSize = exists(cssPath) ? fs.statSync(cssPath).size : 0;
  console.log(`   ${'css/style.css'.padEnd(40)}  ${kb(cssSize).padStart(10)}`);
  console.log(`   ${'─'.repeat(54)}`);
  console.log(`   ${'TOPLAM'.padEnd(40)}  ${kb(total + cssSize).padStart(10)}\n`);
}

// ── Watch modu ────────────────────────────────────────────────
async function startWatch() {
  console.log('\n👀 Watch modu — değişiklikler izleniyor...\n');
  const chokidar = (() => { try { return require('chokidar'); } catch { return null; } })();
  if (!chokidar) {
    console.log('  (npm i -D chokidar ile watch modu aktifleşir)');
    return;
  }

  let timer = null;
  const flush = async () => {
    try {
      const t = Date.now();
      process.stdout.write('♻️  Rebuild... ');
      const result = await buildJS();
      const outFiles = Object.keys(result.metafile.outputs).map(f => path.join(__dirname, '..', f));
      injectSW(outFiles);
      patchHTML(outFiles);
      console.log(`✅ ${Date.now() - t}ms`);
    } catch (e) { console.error('❌', e.message); }
  };

  chokidar
    .watch([JS_SRC, CSS_SRC], { ignoreInitial: true })
    .on('change', file => {
      if (file.endsWith('.css')) { buildCSS().catch(e => console.error(e.message)); return; }
      clearTimeout(timer);
      timer = setTimeout(flush, 60);
    });
}

// ── Ana build ─────────────────────────────────────────────────
async function main() {
  const mode = PROD ? 'production' : (WATCH ? 'watch' : 'development');
  console.log(`\n🔨 Bridge build [${mode}] — ESM splitting${ANALYZE ? ' + analiz' : ''}...\n`);
  const t = Date.now();

  try {
    const [jsResult] = await Promise.all([buildJS(), buildCSS()]);

    const outFiles = Object.keys(jsResult.metafile.outputs)
      .map(f => path.resolve(path.join(__dirname, '..', f)));

    for (const f of outFiles.filter(f => f.endsWith('.js'))) {
      const kb = (fs.statSync(f).size / 1024).toFixed(1);
      console.log(`   ✅ ${path.relative(DIST, f)} — ${kb} KB`);
    }

    copyStatic();
    injectSW(outFiles);
    patchHTML(outFiles);

    if (!WATCH) {
      sizeReport(outFiles);
      console.log(`⚡ Build tamamlandı — ${Date.now() - t}ms\n`);
    } else {
      await startWatch();
    }

    if (ANALYZE) {
      fs.writeFileSync(
        path.join(DIST, 'meta.json'),
        JSON.stringify(jsResult.metafile)
      );
      console.log('📊 meta.json kaydedildi (esbuild-bundle-analyzer ile görüntüle)');
    }
  } catch (e) {
    console.error('\n❌ Build başarısız:', e.message);
    process.exit(1);
  }
}

main();
