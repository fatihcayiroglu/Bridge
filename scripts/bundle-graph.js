#!/usr/bin/env node
// scripts/bundle-graph.js
//
// ════════════════════════════════════════════════════════════════════════════
// PAKET GRAFİĞİ — "İLK İNDİRME" ile "TALEBE GÖRE" AYRIMI
// ════════════════════════════════════════════════════════════════════════════
//
// NEDEN VAR — ölçülmüş bir kusur:
//
//   `check-bundle-budget.js` `dist/js` altındaki BÜTÜN `.js` dosyalarını
//   toplayıp tek bir "JS" sayısı üretiyor ve bunu, adı ve eşiği açıkça İLK
//   İNDİRMEYİ ima eden 1200 KB'lık bütçeyle karşılaştırıyordu.
//
//   Oysa çıktı ESM code-splitting ile üretilir: iki HTML girdisi vardır
//   (`index.html → app`, `marketplace.html → plugin-marketplace-page`) ve
//   dinamik `import()` ile yüklenen parçalar İLK AÇILIŞTA İNDİRİLMEZ.
//   Hiçbir kullanıcı 33 dosyanın tamamını çekmez. Bu yüzden o toplam,
//   hiçbir gerçek sorunun cevabı değildi: ne kullanıcının indirdiği baytı
//   ne de tek bir sayfanın ağırlığını ölçüyordu.
//
// BU MODÜL NE YAPAR
//   esbuild metafile'ındaki import kenarlarını kullanarak her GERÇEK sayfa
//   girdisi için:
//     · initial : girdi + STATİK import kapanışı (tarayıcı ilk boyamada çeker)
//     · lazy    : yalnız dinamik `import()` üzerinden erişilebilen parçalar
//   hesaplar. `kind` ayrımı esbuild tarafından verilir:
//     'import-statement' → statik    'dynamic-import' → talebe göre
'use strict';

const fs = require('fs');
const path = require('path');

/** Yalnızca gerçek SAYFA girdileri; splitting dinamik parçaları da
 *  `entryPoint` ile işaretlediği için `entryPoint` tek başına yeterli değildir. */
const PAGE_ENTRY_BASENAMES = ['app', 'plugin-marketplace-page'];

function readMeta(distDir) {
  const metaFile = path.join(distDir, 'meta.json');
  if (!fs.existsSync(metaFile)) {
    throw new Error(
      `meta.json bulunamadı (${metaFile}). Bütçe kapısı import grafiği olmadan ` +
      'ilk indirmeyi ölçemez; önce `node scripts/build.js` çalıştırın.',
    );
  }
  return JSON.parse(fs.readFileSync(metaFile, 'utf8'));
}

/** `outputs` anahtarları build kökünden görecelidir; taban adı yeterlidir. */
function isPageEntry(outFile, info) {
  if (!info.entryPoint) return false;
  const base = path.basename(info.entryPoint).replace(/\.(ts|js)$/, '');
  return PAGE_ENTRY_BASENAMES.includes(base);
}

function closure(outputs, start, kinds) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const edge of outputs[file]?.imports ?? []) {
      if (!kinds.includes(edge.kind)) continue;
      if (outputs[edge.path]) stack.push(edge.path);
    }
  }
  return seen;
}

function sizeOf(outputs, files) {
  let total = 0;
  for (const f of files) total += outputs[f]?.bytes ?? 0;
  return total;
}

/**
 * @returns {{
 *   pages: Array<{ name: string, file: string, initialBytes: number, initialFiles: number,
 *                  lazyBytes: number, lazyFiles: number }>,
 *   totalBytes: number, totalFiles: number,
 *   worstInitialBytes: number, orphanBytes: number, orphanFiles: string[],
 * }}
 */
function analyzeBundleGraph(distDir) {
  const meta = readMeta(distDir);
  const outputs = meta.outputs || {};
  const jsFiles = Object.keys(outputs).filter(f => f.endsWith('.js'));

  const pages = [];
  const reachable = new Set();
  for (const file of jsFiles) {
    const info = outputs[file];
    if (!isPageEntry(file, info)) continue;
    const initial = closure(outputs, file, ['import-statement']);
    const all = closure(outputs, file, ['import-statement', 'dynamic-import']);
    for (const f of all) reachable.add(f);
    const lazy = [...all].filter(f => !initial.has(f));
    pages.push({
      name: path.basename(info.entryPoint).replace(/\.(ts|js)$/, ''),
      file,
      initialBytes: sizeOf(outputs, initial),
      initialFiles: initial.size,
      lazyBytes: sizeOf(outputs, lazy),
      lazyFiles: lazy.length,
    });
  }

  // Hiçbir sayfadan erişilemeyen çıktı = ölü ağırlık. Sessizce toplama
  // katılmamalı; ayrıca raporlanır ki sevk edilen ölü kod görünür olsun.
  const orphanFiles = jsFiles.filter(f => !reachable.has(f));

  return {
    pages: pages.sort((a, b) => b.initialBytes - a.initialBytes),
    totalBytes: sizeOf(outputs, jsFiles),
    totalFiles: jsFiles.length,
    worstInitialBytes: pages.reduce((max, p) => Math.max(max, p.initialBytes), 0),
    orphanBytes: sizeOf(outputs, orphanFiles),
    orphanFiles,
  };
}

module.exports = { analyzeBundleGraph, closure, PAGE_ENTRY_BASENAMES };
