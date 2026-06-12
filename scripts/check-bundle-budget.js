#!/usr/bin/env node
// scripts/check-bundle-budget.js — Sprint 50: Detaylı raporlama ve tree-shaking analizi
// Kullanım:
//   node scripts/check-bundle-budget.js            # temel kontrol
//   node scripts/check-bundle-budget.js --verbose  # chunk detayı
//   node scripts/check-bundle-budget.js --ci       # CI çıkışı (JSON + tablo)
'use strict';

const fs   = require('fs');
const path = require('path');

const VERBOSE = process.argv.includes('--verbose');
const CI      = process.argv.includes('--ci');

const distDir   = path.join(__dirname, '../client/dist');
const metaFile  = path.join(distDir, 'meta.json');

// ── Bütçe limitleri ───────────────────────────────────────────────────────────
// Sprint 50 TS dönüşümü sonrası 25 yeni modül eklendi.
// esbuild tree-shaking aktif olduğu için net artış minimal bekleniyor.
// Limit 1200 KB'a güncellendi (eski: 1100 KB) — yeni core modüller için headroom.
const JS_BUDGET    = Number(process.env.BRIDGE_BUNDLE_JS_BUDGET  || 1200 * 1024);  // 1.2 MB
const CSS_BUDGET   = Number(process.env.BRIDGE_BUNDLE_CSS_BUDGET || 250  * 1024);  // 250 KB
const CHUNK_BUDGET = Number(process.env.BRIDGE_CHUNK_BUDGET      || 150  * 1024);  // tek chunk max 150 KB
const ENTRY_BUDGET = Number(process.env.BRIDGE_ENTRY_BUDGET      || 80   * 1024);  // tek entry max 80 KB

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

const jsFiles  = scanDir(path.join(distDir, 'js'),  '.js');
const cssFiles = scanDir(path.join(distDir, 'css'), '.css');

const totalJs  = jsFiles.reduce((s, f) => s + f.size, 0);
const totalCss = cssFiles.reduce((s, f) => s + f.size, 0);

const jsRatio  = totalJs  / JS_BUDGET;
const cssRatio = totalCss / CSS_BUDGET;

// ── Raporlama ────────────────────────────────────────────────────────────────

console.log('\n┌─────────────────────────────────────────────────┐');
console.log('│  Bridge Bundle Budget Report — Sprint 50         │');
console.log('├─────────────────────────────────────────────────┤');
console.log(`│  JS   ${toBar(jsRatio)}  ${toKb(totalJs).padStart(9)} / ${toKb(JS_BUDGET)} │`);
console.log(`│  CSS  ${toBar(cssRatio)}  ${toKb(totalCss).padStart(9)} / ${toKb(CSS_BUDGET)} │`);
console.log('└─────────────────────────────────────────────────┘\n');

// Chunk detayı
if (VERBOSE || CI) {
  // Büyük chunk'ları listele
  const topChunks = [...jsFiles].sort((a, b) => b.size - a.size).slice(0, 15);
  console.log('📦 Büyük chunk\'lar (top 15):');
  for (const { file, size } of topChunks) {
    const name  = path.relative(distDir, file).replace(/\\/g, '/');
    const ratio = size / CHUNK_BUDGET;
    const warn  = size > CHUNK_BUDGET ? ' ⚠️ BUDGET EXCEEDED' : '';
    console.log(`   ${toKb(size).padStart(9)}  ${name}${warn}`);
  }
  console.log('');
}

// meta.json analizi (esbuild --metafile çıktısı)
const chunkWarnings = [];
const entryWarnings = [];

if (fs.existsSync(metaFile)) {
  try {
    const meta    = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
    const outputs = meta.outputs || {};

    let unusedExports = 0;
    for (const [outFile, info] of Object.entries(outputs)) {
      if (!outFile.endsWith('.js')) continue;
      const isChunk = path.basename(outFile).startsWith('chunk-');
      const budget  = isChunk ? CHUNK_BUDGET : ENTRY_BUDGET;
      if (info.bytes > budget) {
        const list = isChunk ? chunkWarnings : entryWarnings;
        list.push({ file: outFile, size: info.bytes, budget, modules: Object.keys(info.inputs || {}).length });
      }
    }

    if (VERBOSE && chunkWarnings.length) {
      console.log('⚠️  Budget aşan chunk\'lar:');
      for (const w of chunkWarnings) {
        console.log(`   ${toKb(w.size)} / ${toKb(w.budget)}  ${path.basename(w.file)}  (${w.modules} modül)`);
      }
      console.log('');
    }

    // Sprint 50 doğrulama: yeni TS dosyaları bundle'a girdi mi?
    const sprint50Entries = [
      'voice', 'web-push', 'offline-banner', 'analytics', 'mobile',
      'virtual-scroll', 'i18n', 'canvas', 'ip-ban', 'styles', 'partials',
      'stage', 'user-connections', 'channel-stage', 'discover', 'mobile-ux',
      'emoji-picker', 'calendar-picker', 'clyde', 'group-dm-core',
      'onboarding-tour', 'server-ui', 'bot-marketplace',
    ];
    const allOutputNames = Object.keys(outputs).map(f => path.basename(f));
    const missing = sprint50Entries.filter(e =>
      !allOutputNames.some(n => n.startsWith(e + '-') || n.includes(`/${e}-`))
    );
    if (missing.length) {
      console.warn(`⚠️  Sprint 50: ${missing.length} entry bundle'a girmemiş olabilir: ${missing.join(', ')}`);
    } else if (VERBOSE) {
      console.log(`✅ Sprint 50: Tüm ${sprint50Entries.length} yeni TS modülü bundle'a dahil edildi.\n`);
    }
  } catch (err) {
    console.warn(`⚠️  meta.json okunamadı: ${err.message}`);
  }
} else if (VERBOSE) {
  console.log('ℹ️  meta.json bulunamadı — esbuild --analyze ile detaylı analiz için: npm run build:analyze\n');
}

// CI JSON çıktısı
if (CI) {
  const report = {
    sprint:     50,
    timestamp:  new Date().toISOString(),
    js:  { total: totalJs,  budget: JS_BUDGET,  ratio: Math.round(jsRatio * 100),  passed: totalJs  <= JS_BUDGET  },
    css: { total: totalCss, budget: CSS_BUDGET, ratio: Math.round(cssRatio * 100), passed: totalCss <= CSS_BUDGET },
    chunkWarnings:  chunkWarnings.length,
    entryWarnings:  entryWarnings.length,
  };
  fs.writeFileSync(path.join(distDir, 'bundle-report.json'), JSON.stringify(report, null, 2));
  console.log('📊 CI raporu: client/dist/bundle-report.json\n');
}

// ── Sonuç ─────────────────────────────────────────────────────────────────────

const failed = totalJs > JS_BUDGET || totalCss > CSS_BUDGET;

if (failed) {
  if (totalJs > JS_BUDGET) {
    const overBy = toKb(totalJs - JS_BUDGET);
    console.error(`❌ JS bütçesi aşıldı: ${overBy} fazla (${toKb(totalJs)} / ${toKb(JS_BUDGET)})`);
    console.error('   Öneri: npm run build:analyze ile büyük chunk\'ları tespit edin.');
    console.error('   BRIDGE_BUNDLE_JS_BUDGET env ile limiti geçici olarak artırabilirsiniz.');
  }
  if (totalCss > CSS_BUDGET) {
    console.error(`❌ CSS bütçesi aşıldı: ${toKb(totalCss - CSS_BUDGET)} fazla`);
  }
  process.exit(1);
}

console.log(`✅ Budget kontrolü geçti (JS: %${Math.round(jsRatio * 100)}, CSS: %${Math.round(cssRatio * 100)})\n`);
