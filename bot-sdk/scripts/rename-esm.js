#!/usr/bin/env node
/* eslint-disable no-console */
//
// ════════════════════════════════════════════════════════════════════════════
// ESM ÇIKTISINI `dist/*.mjs` OLARAK YERLEŞTİR
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR: `package.json` şunu ilan ediyor
//
//     "build:esm": "tsc ... --outDir dist/esm && node scripts/rename-esm.js"
//
// ama `bot-sdk/scripts/` DİZİNİ HİÇ YOKTU. Yani `npm run build` HER ZAMAN
// başarısızdı:
//
//     Error: Cannot find module '.../bot-sdk/scripts/rename-esm.js'
//
// Hiçbir CI işi bu paketi derlemediği için bu görünmedi — aynı sınıf,
// `bot-sdk/tests/sdk.test.ts` süitinin hiç koşulmamasıyla aynı kökten.
//
// Sonucu somut: `package.json` `exports.import` alanı `./dist/index.mjs`
// gösteriyor, ama o dosya hiç üretilmiyordu. Paket ESM ile `import` edildiğinde
// ERR_MODULE_NOT_FOUND alırdı.
//
// Bu betik `tsc --module esnext` çıktısını (`dist/esm/*.js`) ilan edilen
// konuma taşır: `dist/*.mjs`. `.d.ts` dosyaları CJS derlemesinden zaten
// `dist/` içinde üretilir, bu yüzden kopyalanmaz.

const fs = require('fs');
const path = require('path');

const DIST = path.resolve(__dirname, '..', 'dist');
const ESM  = path.join(DIST, 'esm');

if (!fs.existsSync(ESM)) {
  console.error(`[rename-esm] ${ESM} yok — önce "tsc --module esnext --outDir dist/esm" çalışmalı.`);
  process.exit(1);
}

let moved = 0;
for (const entry of fs.readdirSync(ESM)) {
  const from = path.join(ESM, entry);
  if (!fs.statSync(from).isFile()) continue;

  // Yalnızca JS çıktısı taşınır. Tip bildirimleri (.d.ts / .d.ts.map) CJS
  // derlemesinden `dist/` içinde zaten mevcut; ikinci bir kopya `types`
  // alanının hangisini gösterdiğini belirsizleştirirdi.
  if (!entry.endsWith('.js') && !entry.endsWith('.js.map')) continue;

  const target = entry.endsWith('.js.map')
    ? entry.replace(/\.js\.map$/, '.mjs.map')
    : entry.replace(/\.js$/, '.mjs');
  const to = path.join(DIST, target);

  let code = fs.readFileSync(from, 'utf8');
  if (entry.endsWith('.js')) {
    // Göreli import belirteçleri de `.mjs` olmalı, aksi hâlde Node çözemez.
    code = code.replace(/(from\s+['"]\.\.?\/[^'"]+?)\.js(['"])/g, '$1.mjs$2');
    // sourceMappingURL yeni ada göre düzeltilir.
    code = code.replace(/\/\/# sourceMappingURL=(.+)\.js\.map/g, '//# sourceMappingURL=$1.mjs.map');
  }
  fs.writeFileSync(to, code);
  moved++;
}

fs.rmSync(ESM, { recursive: true, force: true });

// İlan edilen giriş noktası gerçekten üretilmiş olmalı; aksi hâlde paket
// ESM tarafında çözülemez ve bu betik sessizce "başarılı" görünürdü.
const declared = path.join(DIST, 'index.mjs');
if (!fs.existsSync(declared)) {
  console.error('[rename-esm] dist/index.mjs üretilmedi — package.json exports.import bozuk kalırdı.');
  process.exit(1);
}

console.log(`[rename-esm] ${moved} dosya dist/*.mjs olarak yerleştirildi.`);
