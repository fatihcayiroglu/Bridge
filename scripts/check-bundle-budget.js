#!/usr/bin/env node
// scripts/check-bundle-budget.js — Bridge paket bütçesi kapısı
// Kullanım:
//   node scripts/check-bundle-budget.js            # temel kontrol
//   node scripts/check-bundle-budget.js --verbose  # chunk detayı
//   node scripts/check-bundle-budget.js --ci       # CI çıkışı (JSON + tablo)
//
// ════════════════════════════════════════════════════════════════════════════
// ÖLÇÜLEN KUSUR: BÜTÇE YANLIŞ ŞEYİ SAYIYORDU
// ════════════════════════════════════════════════════════════════════════════
//
// Eski hâli `dist/js` altındaki BÜTÜN `.js` dosyalarını topluyor ve bu tek
// sayıyı 1200 KB'lık bütçeyle karşılaştırıyordu. Çıktı ise ESM code-splitting
// ile üretiliyor: iki HTML girdisi (`index.html → app`,
// `marketplace.html → plugin-marketplace-page`) ve dinamik `import()` ile
// TALEBE GÖRE yüklenen parçalar. Hiçbir kullanıcı 34 dosyanın tamamını
// indirmez; dolayısıyla o toplam ne "kullanıcının indirdiği bayt"tı ne de
// "bir sayfanın ağırlığı". Kapı, ölçmek istediği şeyden başka bir şeyi
// ölçüyor ve yapısal olarak kırmızı kalıyordu (3316.6 KB / 1200 KB).
//
// DÜZELTME: bütçe ARTIRILMADI. Sayı aynı kaldı (1200 KB) ve artık DOĞRU
// büyüklüğe uygulanıyor: her sayfanın İLK İNDİRMESİ = girdi + statik import
// kapanışı. Ölçüm ayrıca gerçek bir kod bölmeyle de desteklendi:
// `mediasoup-client` (190.5 KB) statik import'tan çıkarılıp talebe göre
// yüklenir hâle getirildi — kütüphane yalnızca kullanıcı bir SFU odasına
// katıldığında gerekir.
//
// LAZY TARAF SERBEST DEĞİLDİR: toplam sevk edilen JS için AYRI bir tavan
// eklendi. Bu, mevcut boyutu "meşrulaştırmak" için değil, ilk indirmeden
// çıkarılan ağırlığın sessizce sınırsız büyümesini engellemek içindir.
'use strict';

const fs   = require('fs');
const path = require('path');
const { analyzeBundleGraph } = require('./bundle-graph.js');

const VERBOSE = process.argv.includes('--verbose');
const CI      = process.argv.includes('--ci');

const distDir  = path.join(__dirname, '../client/dist');
const metaFile = path.join(distDir, 'meta.json');

// ── Bütçe limitleri ───────────────────────────────────────────────────────────
// INITIAL: bir sayfanın ilk boyamada indirdiği JS (girdi + statik kapanış).
// TOTAL  : sevk edilen tüm JS (initial + talebe göre yüklenen her şey).
const JS_BUDGET    = Number(process.env.BRIDGE_BUNDLE_JS_BUDGET    || 1200 * 1024);
const TOTAL_BUDGET = Number(process.env.BRIDGE_BUNDLE_TOTAL_BUDGET || 3500 * 1024);
const CSS_BUDGET   = Number(process.env.BRIDGE_BUNDLE_CSS_BUDGET   || 250  * 1024);
const CHUNK_BUDGET = Number(process.env.BRIDGE_CHUNK_BUDGET        || 150  * 1024);
const ENTRY_BUDGET = Number(process.env.BRIDGE_ENTRY_BUDGET        || 80   * 1024);

// ── Yardımcılar ───────────────────────────────────────────────────────────────

function toKb(bytes) { return `${(bytes / 1024).toFixed(1)} KB`; }
function toBar(ratio, width = 20) {
  const filled = Math.round(Math.min(ratio, 1) * width);
  return '[' + '█'.repeat(filled) + '░'.repeat(width - filled) + ']';
}

function scanDir(dir, ext) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { results.push(...scanDir(full, ext)); continue; }
    if (entry.name.endsWith(ext)) results.push({ file: full, size: fs.statSync(full).size });
  }
  return results;
}

// ── Ana kontrol ───────────────────────────────────────────────────────────────

if (!fs.existsSync(distDir)) {
  console.error('[Bridge] client/dist bulunamadı. Önce build çalıştırın: npm run build');
  process.exit(1);
}
if (!fs.existsSync(metaFile)) {
  // Grafik olmadan "ilk indirme" hesaplanamaz. Sessizce toplam bayta düşmek,
  // tam olarak düzeltilen kusuru geri getirirdi.
  console.error('[Bridge] client/dist/meta.json yok — bütçe kapısı import grafiği olmadan');
  console.error('         ilk indirmeyi ölçemez. `node scripts/build.js` çalıştırın.');
  process.exit(1);
}

const graph    = analyzeBundleGraph(distDir);
const jsFiles  = scanDir(path.join(distDir, 'js'),  '.js');
const cssFiles = scanDir(path.join(distDir, 'css'), '.css');
const totalCss = cssFiles.reduce((s, f) => s + f.size, 0);

// ── BILESEN CSS'I DE OLCULUR ─────────────────────────────────────────────────
// Svelte bilesen stilleri artik `dist/js` yanina ayri .css dosyalari olarak
// yaziliyor (scripts/build.js: `css: 'external'`; gerekce orada belgeli —
// calisma zamaninda enjekte edilen <style> ogelerini uygulamanin KENDI CSP'si
// engelliyordu).
//
// Bu baytlar ONCEDEN de sevk ediliyordu: JS paketinin ICINDE dizge olarak
// duruyor ve JS butcesinde sayiliyorlardi. Dosya turu degistigi icin olcum
// disinda kalmalari, hicbir gercek kazanc olmadan gecidi GEVSETIRDI. Bu yuzden
// ayri bir satirda raporlanir ve TOPLAM SEVK rakamina dahil edilir.
const componentCssFiles = scanDir(path.join(distDir, 'js'), '.css');
const componentCss      = componentCssFiles.reduce((s, f) => s + f.size, 0);
const totalShipped      = graph.totalBytes + componentCss;

const worstPage    = graph.pages[0];
const initialRatio = graph.worstInitialBytes / JS_BUDGET;
const totalRatio   = totalShipped / TOTAL_BUDGET;
const cssRatio     = totalCss / CSS_BUDGET;

// ── Raporlama ────────────────────────────────────────────────────────────────

console.log('\n┌──────────────────────────────────────────────────────────┐');
console.log('│  Bridge Bundle Budget Report                              │');
console.log('├──────────────────────────────────────────────────────────┤');
console.log(`│  JS ilk indirme ${toBar(initialRatio)} ${toKb(graph.worstInitialBytes).padStart(9)} / ${toKb(JS_BUDGET)} │`);
console.log(`│  Toplam sevk    ${toBar(totalRatio)} ${toKb(totalShipped).padStart(9)} / ${toKb(TOTAL_BUDGET)} │`);
console.log(`│    └ bilesen CSS                    ${toKb(componentCss).padStart(9)}            │`);
console.log(`│  CSS            ${toBar(cssRatio)} ${toKb(totalCss).padStart(9)} / ${toKb(CSS_BUDGET)} │`);
console.log('└──────────────────────────────────────────────────────────┘\n');

console.log('📄 Sayfa başına indirme:');
for (const page of graph.pages) {
  const flag = page.initialBytes > JS_BUDGET ? ' ❌' : ' ✅';
  console.log(
    `   ${page.name.padEnd(26)} ilk: ${toKb(page.initialBytes).padStart(9)} (${String(page.initialFiles).padStart(2)} dosya)` +
    `   talebe göre: ${toKb(page.lazyBytes).padStart(9)} (${String(page.lazyFiles).padStart(2)} dosya)${flag}`,
  );
}
if (graph.orphanFiles.length) {
  console.log(`\n⚠️  Hiçbir sayfadan erişilemeyen çıktı: ${graph.orphanFiles.length} dosya / ${toKb(graph.orphanBytes)}`);
  for (const f of graph.orphanFiles) console.log(`     ${path.basename(f)}`);
}
console.log('');

// Chunk detayı
if (VERBOSE || CI) {
  const topChunks = [...jsFiles].sort((a, b) => b.size - a.size).slice(0, 15);
  console.log('📦 Büyük chunk\'lar (top 15):');
  for (const { file, size } of topChunks) {
    const name = path.relative(distDir, file).replace(/\\/g, '/');
    const warn = size > CHUNK_BUDGET ? ' ⚠️ CHUNK BUDGET EXCEEDED' : '';
    console.log(`   ${toKb(size).padStart(9)}  ${name}${warn}`);
  }
  console.log('');
}

// meta.json analizi — chunk/entry alt bütçeleri (uyarı düzeyi).
const chunkWarnings = [];
const entryWarnings = [];
try {
  const meta    = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  const outputs = meta.outputs || {};
  for (const [outFile, info] of Object.entries(outputs)) {
    if (!outFile.endsWith('.js')) continue;
    const isChunk = path.basename(outFile).startsWith('chunk-');
    const budget  = isChunk ? CHUNK_BUDGET : ENTRY_BUDGET;
    if (info.bytes > budget) {
      const list = isChunk ? chunkWarnings : entryWarnings;
      list.push({ file: outFile, size: info.bytes, budget, modules: Object.keys(info.inputs || {}).length });
    }
  }
  // Bu uyarılar eskiden YALNIZ `--verbose` ile basılıyordu ve `--analyze`
  // olmadan meta.json hiç yazılmadığı için CI'da HİÇ görünmüyorlardı.
  for (const [label, list] of [['chunk', chunkWarnings], ['entry', entryWarnings]]) {
    if (!list.length) continue;
    console.log(`⚠️  ${label} alt bütçesini aşanlar (${list.length}):`);
    for (const w of list.slice(0, 10)) {
      console.log(`   ${toKb(w.size).padStart(9)} / ${toKb(w.budget)}  ${path.basename(w.file)}  (${w.modules} modül)`);
    }
    console.log('');
  }
} catch (err) {
  console.warn(`⚠️  meta.json okunamadı: ${err.message}`);
}

// CI JSON çıktısı
if (CI) {
  const report = {
    timestamp: new Date().toISOString(),
    initial: {
      worst:  graph.worstInitialBytes,
      budget: JS_BUDGET,
      ratio:  Math.round(initialRatio * 100),
      passed: graph.worstInitialBytes <= JS_BUDGET,
      pages:  graph.pages,
    },
    total: { bytes: totalShipped, js: graph.totalBytes, componentCss, budget: TOTAL_BUDGET, passed: totalShipped <= TOTAL_BUDGET },
    css:   { total: totalCss, budget: CSS_BUDGET, passed: totalCss <= CSS_BUDGET },
    chunkWarnings: chunkWarnings.length,
    entryWarnings: entryWarnings.length,
    orphanFiles:   graph.orphanFiles.length,
  };
  fs.writeFileSync(path.join(distDir, 'bundle-report.json'), JSON.stringify(report, null, 2));
  console.log('📊 CI raporu: client/dist/bundle-report.json\n');
}

// ── Sonuç ─────────────────────────────────────────────────────────────────────

const failures = [];
if (graph.worstInitialBytes > JS_BUDGET) {
  failures.push(
    `JS ilk indirme bütçesi aşıldı: ${toKb(graph.worstInitialBytes - JS_BUDGET)} fazla ` +
    `(${worstPage ? worstPage.name : '?'}: ${toKb(graph.worstInitialBytes)} / ${toKb(JS_BUDGET)})`,
  );
}
if (totalShipped > TOTAL_BUDGET) {
  failures.push(`Toplam sevk edilen bütçe aşıldı (JS + bilesen CSS): ${toKb(totalShipped - TOTAL_BUDGET)} fazla`);
}
if (totalCss > CSS_BUDGET) {
  failures.push(`CSS bütçesi aşıldı: ${toKb(totalCss - CSS_BUDGET)} fazla`);
}

if (failures.length) {
  for (const line of failures) console.error(`❌ ${line}`);
  console.error('   Öneri: `npm run build:analyze` ile grafiği inceleyin; ilk indirmeden');
  console.error('   çıkarılabilecek modülleri dinamik `import()` ile talebe göre yükleyin.');
  process.exit(1);
}

console.log(
  `✅ Budget kontrolü geçti — ilk indirme %${Math.round(initialRatio * 100)}, ` +
  `toplam %${Math.round(totalRatio * 100)}, CSS %${Math.round(cssRatio * 100)}\n`,
);
