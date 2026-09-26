#!/usr/bin/env node
'use strict';

// Stable locale quality gate.
// Dependency-free on purpose: release certification must work before npm ci.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const I18N_DIR = path.resolve(__dirname, '../client/js/core/i18n');
const LANGS = ['tr', 'en', 'es', 'ru', 'ja', 'ko', 'zh', 'pt', 'de', 'fr'];
const REF_LANG = 'en';
const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;
const MAX_IDENTICAL_RATIO = { tr: 0.08, es: 0.05, ru: 0.02, ja: 0.02, ko: 0.02, zh: 0.02, pt: 0.05, de: 0.06, fr: 0.06 };
const NATIVE_SCRIPT = {
  ru: /[А-Яа-яЁё]/,
  ja: /[ぁ-んァ-ン一-龯]/,
  ko: /[가-힣]/,
  zh: /[一-龯]/,
};

function readLocale(lang) {
  const file = path.join(I18N_DIR, `${lang}.ts`);
  if (!fs.existsSync(file)) throw new Error(`Dil dosyası bulunamadı: ${file}`);
  const src = fs.readFileSync(file, 'utf8');
  const marker = /const\s+translations\s*:\s*Record<string,\s*string>\s*=\s*/;
  const match = marker.exec(src);
  if (!match) throw new Error(`${lang}: translations object başlangıcı bulunamadı`);
  const start = match.index + match[0].length;
  const exportAt = src.indexOf('export default translations', start);
  if (exportAt < 0) throw new Error(`${lang}: export default translations bulunamadı`);
  const end = src.lastIndexOf(';', exportAt);
  if (end < start) throw new Error(`${lang}: translations object sonu bulunamadı`);
  const literal = src.slice(start, end).trim();
  const table = vm.runInNewContext(`(${literal})`, Object.create(null), { timeout: 1000 });
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error(`${lang}: tablo nesne değil`);

  // ── AYNI ANAHTARIN İKİ KEZ TANIMLANMASI ──────────────────────────────────
  // Nesne literali DEĞERLENDİRİLDİKTEN sonra yinelenen anahtar GÖRÜNMEZ:
  // ikinci tanım birinciyi sessizce ezer ve `Object.entries` tek girdi
  // döndürür. Bu yüzden parite kontrolü yinelemeye KÖRDÜ — bir çeviri, kimse
  // fark etmeden ölü koda dönüşebilirdi. (Ölçüldü: `voice_connected` sekiz
  // dilde iki kez tanımlanmıştı ve bunu yalnızca TypeScript TS1117 yakaladı.)
  //
  // Ham metin üzerinden sayılır, çünkü aranan şey tam olarak değerlendirme
  // sırasında KAYBOLAN bilgidir. SATIR BAZLI tarama YETMEZ: bu tablolarda tek
  // satırda birden çok anahtar var (`'a': 'A', 'b': 'B',`). Bu yüzden literal
  // karakter karakter yürünür ve dize sınırları izlenir; böylece bir ÇEVİRİ
  // METNİNİN içindeki `'x':` görüntüsü anahtar sanılmaz.
  const duplicateKeys = new Set();
  {
    const seenKeys = new Set();
    let inString = null;      // aktif tırnak karakteri
    let buffer = '';          // o an okunan dizenin içeriği
    let lastString = null;    // kapanan en son dize
    for (let i = 0; i < literal.length; i += 1) {
      const ch = literal[i];
      if (inString) {
        if (ch === '\\') { i += 1; continue; }
        if (ch === inString) { lastString = buffer; inString = null; buffer = ''; continue; }
        buffer += ch;
        continue;
      }
      if (ch === "'" || ch === '"' || ch === '`') { inString = ch; buffer = ''; continue; }
      if (ch === ':' && lastString !== null) {
        if (seenKeys.has(lastString)) duplicateKeys.add(lastString);
        else seenKeys.add(lastString);
        lastString = null;
        continue;
      }
      if (ch === ',') lastString = null;
    }
  }
  if (duplicateKeys.size) {
    throw new Error(
      `${lang}: yinelenen çeviri anahtarı — ikinci tanım birinciyi ezer: ${[...duplicateKeys].join(', ')}`);
  }

  for (const [key, value] of Object.entries(table)) {
    if (typeof value !== 'string') throw new Error(`${lang}.${key}: çeviri string değil`);
  }
  return table;
}

function placeholders(value) {
  return [...value.matchAll(PLACEHOLDER)].map(m => m[1]).sort();
}

let failed = false;
const tables = {};
for (const lang of LANGS) {
  try { tables[lang] = readLocale(lang); }
  catch (error) { console.error(`HATA [${lang}]: ${error.message}`); failed = true; }
}

const ref = tables[REF_LANG];
if (!ref) process.exit(1);
const refKeys = Object.keys(ref);
const refSet = new Set(refKeys);

for (const lang of LANGS) {
  const table = tables[lang];
  if (!table) continue;
  const keys = Object.keys(table);
  const keySet = new Set(keys);
  const missing = refKeys.filter(k => !keySet.has(k));
  const extra = keys.filter(k => !refSet.has(k));
  const empty = keys.filter(k => table[k].trim() === '');
  const placeholderMismatch = refKeys.filter(k => keySet.has(k) && placeholders(ref[k]).join('|') !== placeholders(table[k]).join('|'));

  if (missing.length) { console.error(`HATA [${lang}]: eksik anahtarlar: ${missing.join(', ')}`); failed = true; }
  if (extra.length) { console.error(`HATA [${lang}]: fazla anahtarlar: ${extra.join(', ')}`); failed = true; }
  if (empty.length) { console.error(`HATA [${lang}]: boş değerler: ${empty.join(', ')}`); failed = true; }
  if (placeholderMismatch.length) { console.error(`HATA [${lang}]: placeholder uyuşmazlığı: ${placeholderMismatch.join(', ')}`); failed = true; }

  if (lang !== REF_LANG) {
    const identical = refKeys.filter(k => keySet.has(k) && table[k] === ref[k]);
    const ratio = identical.length / refKeys.length;
    const limit = MAX_IDENTICAL_RATIO[lang];
    if (ratio > limit) {
      console.error(`HATA [${lang}]: İngilizceyle birebir aynı oran ${(ratio * 100).toFixed(1)}% > ${(limit * 100).toFixed(1)}% (${identical.length}/${refKeys.length})`);
      failed = true;
    }
  }

  const script = NATIVE_SCRIPT[lang];
  if (script) {
    const eligible = refKeys.filter(k => /[A-Za-z]{3}/.test(ref[k]) && ref[k].length >= 4);
    const native = eligible.filter(k => script.test(table[k]));
    const ratio = native.length / Math.max(eligible.length, 1);
    if (ratio < 0.97) {
      console.error(`HATA [${lang}]: native-script coverage ${(ratio * 100).toFixed(1)}% < 97%`);
      failed = true;
    }
  }
}

if (failed) {
  console.error('\n❌ i18n stable-locale kalite geçidi başarısız.');
  process.exit(1);
}
console.log(`✅ i18n stable locales: ${LANGS.length}/${LANGS.length}, ${refKeys.length} anahtar/locale, key+placeholder parity PASS.`);
