#!/usr/bin/env node
// scripts/check-i18n-parity.js
// CI kalite geçidi — tüm dil dosyalarının aynı anahtar setine sahip olduğunu doğrular.
//
// Kullanım:
//   node scripts/check-i18n-parity.js
//
// Başarısız olursa:
//   - Hangi dillerde hangi anahtarların eksik/fazla olduğunu raporlar
//   - Exit code 1 ile çıkar (CI pipeline'ı durdurur)

'use strict';

const fs   = require('fs');
const path = require('path');

const I18N_DIR = path.resolve(__dirname, '../client/js/core/i18n');
const LANGS    = ['tr', 'en', 'de', 'fr', 'es', 'ja', 'pt', 'ko', 'ru', 'it', 'zh', 'ar', 'nl', 'he', 'fa'];

function extractKeys(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const keys    = new Set();
  // Match 'key': 'value' or "key": "value" patterns
  const re = /^\s*'([a-z][a-z0-9_]+)'\s*:/gm;
  let m;
  while ((m = re.exec(content)) !== null) {
    keys.add(m[1]);
  }
  return keys;
}

const allKeys = {};
let   errors  = false;

for (const lang of LANGS) {
  const fp = path.join(I18N_DIR, `${lang}.ts`);
  if (!fs.existsSync(fp)) {
    console.error(`HATA: Dil dosyası bulunamadı: ${fp}`);
    errors = true;
    continue;
  }
  allKeys[lang] = extractKeys(fp);
}

// Reference = TR (canonical)
const refLang = 'tr';
const refKeys = allKeys[refLang];

if (!refKeys) {
  console.error('HATA: TR dil dosyası okunamadı.');
  process.exit(1);
}

for (const lang of LANGS) {
  if (lang === refLang) continue;
  const langKeys = allKeys[lang];
  if (!langKeys) continue;

  const missing = [...refKeys].filter(k => !langKeys.has(k));
  const extra   = [...langKeys].filter(k => !refKeys.has(k));

  if (missing.length > 0) {
    console.error(`HATA [${lang}]: TR'de olan ama ${lang}'de eksik anahtarlar: ${missing.join(', ')}`);
    errors = true;
  }
  if (extra.length > 0) {
    console.error(`HATA [${lang}]: ${lang}'de olan ama TR'de eksik anahtarlar: ${extra.join(', ')}`);
    errors = true;
  }
}

if (errors) {
  console.error('\n❌ i18n key parity kontrolü başarısız.');
  console.error('Düzeltme: eksik anahtarları ilgili dil dosyalarına ekleyin.');
  process.exit(1);
} else {
  const totalKeys = refKeys.size;
  console.log(`✅ i18n parity: ${LANGS.length} dil, ${totalKeys} anahtar — tümü eşleşiyor.`);
}
