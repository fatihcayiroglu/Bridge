#!/usr/bin/env node
/**
 * client/scripts/production-reachable-coverage.js
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ÜRETİMDE ULAŞILABİLİR KAPSAM
 * ════════════════════════════════════════════════════════════════════════════
 * `vitest --coverage` TÜM KAYNAK için ölçüm yapar (`coverage.all = true`):
 * üretim paketine hiç girmeyen dosyalar da paydaya dâhil olur ve yüzdeyi
 * OLDUĞUNDAN DÜŞÜK gösterir.
 *
 * Bu betik iki sayıyı da üretir:
 *
 *   · TÜM KAYNAK            — vitest'in raporladığı ham değer
 *   · ÜRETİMDE ULAŞILABİLİR — yalnızca gerçek giriş noktalarından
 *                             (scripts/build.js ENTRY_POINTS) import grafiğiyle
 *                             ulaşılabilen dosyalar
 *
 * ── NEDEN DOSYA DIŞLAMAK DEĞİL ─────────────────────────────────────────────
 * Ulaşılamayan dosyalar `coverage.exclude` ile GİZLENMEZ: gizlemek, ölü kodu
 * görünmez kılıp "yüzde oyunu" olurdu. Her iki sayı da raporlanır; aradaki fark
 * ürünün KENDİSİ hakkında bir bulgudur (bağlanmamış özellik / ölü modül).
 *
 * Kullanım:
 *   node client/scripts/production-reachable-coverage.js
 * (önce `npx vitest run --config vitest.config.mts --coverage` çalışmış olmalı)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const CLIENT = path.resolve(__dirname, '..');
const COVERAGE_JSON = path.join(CLIENT, 'coverage', 'coverage-final.json');

// scripts/build.js gerçek giriş noktaları.
const ENTRIES = ['js/app.ts', 'js/plugin-marketplace-page.ts', 'sw.ts'];

const SUFFIXES = ['', '.ts', '.tsx', '.svelte', '.js', '/index.ts', '/index.js', '/index.svelte'];

function resolveSpec(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = path.resolve(path.dirname(fromFile), spec);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.svelte'),
  ];
  for (const candidate of candidates) {
    for (const suffix of SUFFIXES) {
      const full = candidate + suffix;
      try { if (fs.statSync(full).isFile()) return full; } catch { /* yok */ }
    }
  }
  return null;
}

/**
 * ════════════════════════════════════════════════════════════════════════════
 * YORUMLAR TARANMADAN ÖNCE ÇIKARILIR — ÖLÇÜLMÜŞ BİR HATA
 * ════════════════════════════════════════════════════════════════════════════
 * Bu tarayıcının ilk sürümü şu deseni kullanıyordu:
 *
 *     /(?:from\s*|import\s*\(?\s*|...)['"]([^'"]+)['"]/g
 *
 * `\s*` SATIR SONLARINI da geçer. Bu depodaki yorumlar Türkçedir ve kesme
 * işareti (') içerir. Sonuç: bir yorumun içindeki "from" kelimesi, çok
 * satır aşağıdaki bir kesme işaretiyle eşleşiyor ve ARADAKİ GERÇEK
 * `import ... from './x.ts'` ifadesini YUTUYORDU.
 *
 * Doğrudan ölçüldü: `js/app.ts:25` satırındaki
 *     import { BridgeState } from './core/state-svelte.ts';
 * import'u kaybolduğu için `state-svelte.ts` ve ondan ulaşılan HER ŞEY
 * "ulaşılamaz" sayılıyordu.
 *
 * Bu, ölçüm aracının kendisinin ürettiği bir YANLIŞ NEGATİF idi: ulaşılabilir
 * dosya sayısı olduğundan DÜŞÜK, "ulaşılamaz" listesi olduğundan YÜKSEK
 * çıkıyordu. Kapsam yüzdesi de yanlış paydayla hesaplanıyordu.
 *
 * Düzeltme iki katmanlı:
 *   1. yorumlar tarama ÖNCESİ çıkarılır (dize içindekiler korunur),
 *   2. desen SATIR İÇİ boşlukla sınırlanır, satır sonlarını geçmez.
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  let state = 'code';   // code | line | block | single | double | template
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (state === 'code') {
      if (c === '/' && next === '/') { state = 'line'; i += 2; continue; }
      if (c === '/' && next === '*') { state = 'block'; i += 2; continue; }
      if (c === "'") { state = 'single'; out += c; i++; continue; }
      if (c === '"') { state = 'double'; out += c; i++; continue; }
      if (c === '`') { state = 'template'; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += c; }
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') { state = 'code'; i += 2; continue; }
      if (c === '\n') out += c;      // satır numaraları korunur
      i++; continue;
    }
    // dize/şablon içi: kaçışları atla
    if (c === '\\') { out += c + (next ?? ''); i += 2; continue; }
    out += c;
    if ((state === 'single' && c === "'") || (state === 'double' && c === '"')
      || (state === 'template' && c === '`')) state = 'code';
    i++;
  }
  return out;
}

/** Giriş noktalarından BFS ile ulaşılabilir dosya kümesi. */
function reachableSet() {
  const seen = new Set();
  const queue = [];
  for (const entry of ENTRIES) {
    const p = path.join(CLIENT, entry);
    if (fs.existsSync(p)) { seen.add(p); queue.push(p); }
  }
  // `import ... from '…'`, `import('…')`, `export … from '…'`, `require('…')`
  // NOT: `[^\S\n]*` = satır sonu HARİÇ boşluk. Desen satır atlamaz.
  const RE = /(?:from[^\S\n]*|import[^\S\n]*\(?[^\S\n]*|export[^\S\n]*\*[^\S\n]*from[^\S\n]*|require[^\S\n]*\([^\S\n]*)['"]([^'"\n]+)['"]/g;
  while (queue.length) {
    const file = queue.shift();
    let src = '';
    try { src = stripComments(fs.readFileSync(file, 'utf8')); } catch { continue; }
    RE.lastIndex = 0;
    let m;
    while ((m = RE.exec(src)) !== null) {
      const target = resolveSpec(file, m[1]);
      if (target && !seen.has(target)) { seen.add(target); queue.push(target); }
    }
  }
  return seen;
}


/**
 * Coverage artifacts may be generated on a different OS than the machine that
 * reads them (e.g. Windows CI artifact inspected on Linux).  `path.resolve()`
 * alone treats a Windows absolute path as an ordinary Linux filename, causing
 * every production file to look unreachable.  Re-anchor any path containing
 * the canonical `/client/` segment onto the current checkout.
 */
function coveragePathToCurrent(file) {
  const portable = String(file).replace(/\\/g, '/');
  const lower = portable.toLowerCase();
  const marker = '/client/';
  const idx = lower.lastIndexOf(marker);
  if (idx >= 0) return path.resolve(CLIENT, portable.slice(idx + marker.length));
  return path.resolve(file);
}

/** Istanbul/v8 coverage-final.json → toplam sayaçlar. */
function totals(entries) {
  const t = {
    statements: [0, 0], branches: [0, 0], functions: [0, 0], lines: [0, 0],
  };
  for (const cov of entries) {
    for (const hit of Object.values(cov.s || {})) { t.statements[1]++; if (hit > 0) t.statements[0]++; }
    for (const hit of Object.values(cov.f || {})) { t.functions[1]++; if (hit > 0) t.functions[0]++; }
    for (const arr of Object.values(cov.b || {})) {
      for (const hit of arr) { t.branches[1]++; if (hit > 0) t.branches[0]++; }
    }
    // Satır kapsamı statementMap üzerinden türetilir (v8 sağlayıcısı `l` yazmaz).
    const lineHits = new Map();
    for (const [id, loc] of Object.entries(cov.statementMap || {})) {
      const line = loc.start && loc.start.line;
      if (!line) continue;
      const hit = (cov.s || {})[id] || 0;
      lineHits.set(line, Math.max(lineHits.get(line) || 0, hit));
    }
    for (const hit of lineHits.values()) { t.lines[1]++; if (hit > 0) t.lines[0]++; }
  }
  return t;
}

function pct([covered, total]) {
  return total === 0 ? 100 : (covered / total) * 100;
}

function report(label, t) {
  console.log(`\n${label}`);
  for (const key of ['statements', 'branches', 'functions', 'lines']) {
    const [c, n] = t[key];
    console.log(`  ${key.padEnd(11)}: ${pct(t[key]).toFixed(2)}%  (${c}/${n})`);
  }
}

function main() {
  if (!fs.existsSync(COVERAGE_JSON)) {
    console.error(`HATA: ${COVERAGE_JSON} yok. Önce coverage üretin:`);
    console.error('  npx vitest run --config vitest.config.mts --coverage');
    process.exit(2);
  }
  const raw = JSON.parse(fs.readFileSync(COVERAGE_JSON, 'utf8'));
  const reachable = reachableSet();

  const all = [];
  const live = [];
  const dead = [];
  for (const [file, cov] of Object.entries(raw)) {
    const norm = coveragePathToCurrent(file);
    all.push(cov);
    if (reachable.has(norm)) live.push(cov);
    else dead.push(norm);
  }

  console.log('════════════════════════════════════════════════════════════');
  console.log('CLIENT KAPSAMI — TÜM KAYNAK vs ÜRETİMDE ULAŞILABİLİR');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`kapsam raporundaki dosya   : ${all.length}`);
  console.log(`üretimde ulaşılabilir      : ${live.length}`);
  console.log(`ulaşılamayan (paketlenmez) : ${dead.length}`);

  const allTotals = totals(all);
  const liveTotals = totals(live);
  report('TÜM KAYNAK', allTotals);
  report('ÜRETİMDE ULAŞILABİLİR', liveTotals);

  if (process.argv.includes('--enforce-90')) {
    const allPass = enforceThresholds('CLIENT ALL-SOURCE', allTotals, 90);
    const livePass = enforceThresholds('CLIENT PRODUCTION-REACHABLE', liveTotals, 90);
    if (!allPass || !livePass) process.exitCode = 1;
  }

  if (process.argv.includes('--list-unreachable')) {
    console.log('\nUlaşılamayan dosyalar:');
    for (const f of dead.sort()) console.log('  ' + path.relative(CLIENT, f));
  }
}

// Doğrudan çalıştırıldığında rapor üretir; `require` edildiğinde tarayıcıyı
// paylaşır. Aynı mantığın İKİ kopyası olmamalıdır: `tests/auth-screen-dead-
// controls.test.ts` de aynı yorum-yutma hatasını taşıyan kendi kopyasını
// kullanıyordu ve "legacy modül paketlenmiyor" iddiası YANLIŞ NEDENLE
// geçebiliyordu.
function enforceThresholds(label, t, threshold = 90) {
  const misses = [];
  for (const key of ['statements', 'branches', 'functions', 'lines']) {
    const value = pct(t[key]);
    if (value + Number.EPSILON < threshold) misses.push(`${key} ${value.toFixed(2)}% < ${threshold}%`);
  }
  if (misses.length) {
    console.error(`\nCOVERAGE GATE FAIL — ${label}: ${misses.join(', ')}`);
    return false;
  }
  console.log(`\nCOVERAGE GATE PASS — ${label}: all S/B/F/L >= ${threshold}%`);
  return true;
}

module.exports = { reachableSet, stripComments, resolveSpec, coveragePathToCurrent, ENTRIES, CLIENT, enforceThresholds };

if (require.main === module) main();
