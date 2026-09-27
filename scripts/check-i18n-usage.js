#!/usr/bin/env node
'use strict';

// Production i18n usage integrity gate. Dependency-free by design.
// Guarantees that source-referenced keys exist in every stable locale and
// dynamic t(...) call sites stay within explicitly audited catalog carriers.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CLIENT = path.join(ROOT, 'client');
const I18N = path.join(CLIENT, 'js/core/i18n');
const STABLE = ['tr','en','es','ru','ja','ko','zh','pt','de','fr'];

function readLocale(lang) {
  const file = path.join(I18N, `${lang}.ts`);
  const src = fs.readFileSync(file, 'utf8');
  const marker = /const\s+translations\s*:\s*Record<string,\s*string>\s*=\s*/;
  const m = marker.exec(src);
  if (!m) throw new Error(`${lang}: translations object başlangıcı bulunamadı`);
  const start = m.index + m[0].length;
  const exportAt = src.indexOf('export default translations', start);
  const end = src.lastIndexOf(';', exportAt);
  if (exportAt < 0 || end < start) throw new Error(`${lang}: translations object sonu bulunamadı`);
  return vm.runInNewContext(`(${src.slice(start, end).trim()})`, Object.create(null), { timeout: 1500 });
}

const tables = Object.fromEntries(STABLE.map(lang => [lang, readLocale(lang)]));
const canonical = new Set(Object.keys(tables.en));
const failures = [];

function rel(file) { return path.relative(ROOT, file).replace(/\\/g, '/'); }
function lineAt(src, index) { return src.slice(0, index).split('\n').length; }
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules','dist','coverage','.git','tests','__tests__','fixtures'].includes(entry.name)) continue;
      walk(p, out);
    } else if (entry.isFile() && /\.(?:ts|svelte)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) {
      if (p.startsWith(I18N + path.sep) && /\/(?:tr|en|es|ru|ja|ko|zh|pt|de|fr)\.ts$/.test(p.replace(/\\/g, '/'))) continue;
      out.push(p);
    }
  }
  return out;
}

function stripComments(src) {
  // Dependency-free lexical comment stripper. Regex-based stripping can treat
  // text such as `/api/webpush/*` inside a // comment as a real block comment
  // and accidentally erase following imports/code.
  let out = '', i = 0, mode = 'code', quote = '', escaped = false;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (mode === 'line') {
      if (c === '\n') { out += '\n'; mode = 'code'; } else out += ' ';
      i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { out += '  '; i += 2; mode = 'code'; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    if (mode === 'string') {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === quote) { mode = 'code'; quote = ''; }
      i++; continue;
    }
    if (c === '/' && n === '/') { out += '  '; i += 2; mode = 'line'; continue; }
    if (c === '/' && n === '*') { out += '  '; i += 2; mode = 'block'; continue; }
    if (c === '"' || c === "'" || c === '`') { mode = 'string'; quote = c; out += c; i++; continue; }
    out += c; i++;
  }
  return out;
}

function assertKey(key, file, index, kind) {
  if (!key || key === '') return;
  if (!canonical.has(key)) failures.push(`${rel(file)}:${lineAt(fs.readFileSync(file,'utf8'), index)} ${kind}: locale anahtarı yok: ${key}`);
  for (const lang of STABLE) {
    if (!(key in tables[lang])) failures.push(`${rel(file)}:${lineAt(fs.readFileSync(file,'utf8'), index)} ${kind}: ${lang} içinde yok: ${key}`);
  }
}

// Lightweight first-argument reader: enough for t('x'), t(a ? 'x':'y'),
// t(option.labelKey), and nested property/call expressions.
function firstArg(src, openParen) {
  let i = openParen + 1, depth = 0, quote = null, esc = false;
  const start = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (quote === '`' && c === '$' && src[i+1] === '{') { depth++; i++; continue; }
      if (c === quote && depth === 0) { quote = null; continue; }
      if (quote === '`' && c === '}' && depth > 0) { depth--; continue; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') {
      if (depth > 0) { depth--; continue; }
      if (c === ')') return src.slice(start, i).trim();
    }
    if (c === ',' && depth === 0) return src.slice(start, i).trim();
  }
  return src.slice(start).trim();
}

const allowedDynamic = [
  /^option\.labelKey$/,
  /^cat\.labelKey$/,
  /^category\.labelKey$/,
  /^perm\.labelKey$/,
  /^permission\.labelKey$/,
  /^LEVEL_LABEL_KEY\[level\]$/,
  /^LEVEL_DESCRIPTION_KEY\[level\]$/,
  /^EMOJI_CATEGORIES\.find\([\s\S]+\)\?\.labelKey\s*\?\?\s*['"]['"]$/,
  /^THEME_LABEL_KEYS\[theme\]$/,
  /^THEME_LABEL_KEYS\[nextTheme\(theme\)\]$/,
  /^THEME_LABEL_KEYS\[id\]$/,
];

let tCalls = 0, literalCalls = 0, dynamicCalls = 0;
for (const file of walk(path.join(CLIENT, 'js'))) {
  const rawSrc = fs.readFileSync(file, 'utf8');
  const src = stripComments(rawSrc);

  // A t(...) call without an i18n import is a real runtime/compile bug. The
  // implementation module itself defines t and is excluded from this scan.
  if (/\bt\s*\(/.test(src) && !/\bfunction\s+t\s*\(/.test(src)) {
    const tImportPattern = /import\s*\{[^}]*\bt\b[^}]*\}\s*from\s*['"][^'"]*i18n[^'"]*['"]/g;
    const tImports = [...src.matchAll(tImportPattern)];
    if (tImports.length === 0) failures.push(`${rel(file)}: t() kullanıyor fakat i18n t importu yok`);
    if (tImports.length > 1) failures.push(`${rel(file)}: t() için birden fazla i18n importu var (${tImports.length})`);
  }

  // Dynamic catalog carriers such as { labelKey: 'search_has_file' }.
  for (const m of src.matchAll(/\b(?:labelKey|descriptionKey|titleKey|messageKey|emptyKey|errorKey)\s*:\s*(['"])([^'"\n]+)\1/g)) {
    assertKey(m[2], file, m.index, 'catalog-carrier');
  }

  // Bounded map catalogs whose values are passed to t(...) dynamically.
  for (const mapName of ['THEME_LABEL_KEYS']) {
    const map = src.match(new RegExp(`(?:const|export\\s+const)\\s+${mapName}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`));
    if (map) {
      for (const km of map[1].matchAll(/:\s*(['"])([A-Za-z0-9_.:-]+)\1/g)) assertKey(km[2], file, (map.index ?? 0) + km.index, `${mapName}-catalog`);
    }
  }

  const rx = /\bt\s*\(/g;
  let m;
  while ((m = rx.exec(src))) {
    // Ignore function declarations `function t(` and method signatures `.t(` are not matched by word context alone.
    const prefix = src.slice(Math.max(0, m.index - 24), m.index);
    if (/function\s+$/.test(prefix) || /(?:function|interface)\s+\w*\s*$/.test(prefix)) continue;
    tCalls++;
    const arg = firstArg(src, m.index + m[0].lastIndexOf('('));
    const literal = /^(['"])([^'"\n]*)\1$/.exec(arg);
    if (literal) {
      literalCalls++;
      assertKey(literal[2], file, m.index, 'literal-t');
      continue;
    }

    // A conditional made only from literal keys is statically closed.
    if (arg.includes('?')) {
      const keys = [...arg.matchAll(/(['"])([A-Za-z0-9_.:-]+)\1/g)].map(x => x[2]).filter(k => canonical.has(k));
      if (keys.length >= 2) {
        dynamicCalls++;
        for (const key of keys) assertKey(key, file, m.index, 'conditional-t');
        continue;
      }
    }

    const normalized = arg.replace(/\s+/g, ' ').trim();
    if (allowedDynamic.some(rx => rx.test(normalized))) {
      dynamicCalls++;
      continue;
    }

    // i18n-dom resolves data-i18n/data-i18n-placeholder attributes. Their
    // concrete keys are audited from index.html below.
    if (rel(file) === 'client/js/core/i18n-dom.ts' && normalized === 'key') {
      dynamicCalls++;
      continue;
    }

    // api-error.ts is deliberately keyed by a bounded STATUS_KEY catalog.
    if (rel(file) === 'client/js/core/api-error.ts' && normalized === 'key') {
      dynamicCalls++;
      const block = src.match(/const\s+STATUS_KEY[^=]*=\s*\{([\s\S]*?)\n\};/);
      if (!block) failures.push(`${rel(file)}: STATUS_KEY katalogu bulunamadı`);
      else {
        for (const km of block[1].matchAll(/:\s*(['"])([A-Za-z0-9_.:-]+)\1/g)) assertKey(km[2], file, (block.index ?? 0) + km.index, 'api-error-status-catalog');
      }
      for (const key of ['error_generic', 'error_network', 'error_forbidden', 'error_ratelimit']) assertKey(key, file, m.index, 'api-error-bounded-key');
      continue;
    }

    failures.push(`${rel(file)}:${lineAt(src, m.index)} denetlenmemiş dinamik t() ilk argümanı: ${normalized.slice(0,180)}`);
  }
}

// Service Worker owns a tiny self-contained notification dictionary because
// classic /sw.js cannot import the app's lazy locale modules. Keep every value
// byte-for-byte aligned with the canonical stable locale table.
const swFile = path.join(CLIENT, 'sw.ts');
if (fs.existsSync(swFile)) {
  const sw = fs.readFileSync(swFile, 'utf8');
  const start = sw.indexOf('const SW_COPY:');
  const end = sw.indexOf('function normalizeWorkerLocale', start);
  if (start < 0 || end < 0) failures.push('client/sw.ts: SW_COPY sözlüğü bulunamadı');
  else {
    const block = sw.slice(start, end);
    for (const lang of STABLE) {
      const line = block.split('\n').find(row => new RegExp(`^\\s*${lang}:\\s*\\{`).test(row));
      if (!line) { failures.push(`client/sw.ts: SW_COPY.${lang} bulunamadı`); continue; }
      const open = line.indexOf('{');
      const close = line.lastIndexOf('}');
      if (open < 0 || close <= open) { failures.push(`client/sw.ts: SW_COPY.${lang} parse edilemedi`); continue; }
      let workerTable;
      try { workerTable = vm.runInNewContext(`(${line.slice(open, close + 1)})`, Object.create(null), { timeout: 500 }); }
      catch (error) { failures.push(`client/sw.ts: SW_COPY.${lang} parse hatası: ${error.message}`); continue; }
      for (const [key, value] of Object.entries(workerTable)) {
        assertKey(key, swFile, start, 'service-worker-copy');
        if (tables[lang][key] !== value) failures.push(`client/sw.ts: SW_COPY.${lang}.${key} canonical locale ile farklı`);
      }
      const enWorkerKeys = Object.keys(workerTable);
      if (lang === 'en') globalThis.__workerKeys = enWorkerKeys;
      else if (globalThis.__workerKeys && enWorkerKeys.join('|') !== globalThis.__workerKeys.join('|')) {
        failures.push(`client/sw.ts: SW_COPY.${lang} anahtar seti en ile aynı değil`);
      }
    }
  }
}

// Static DOM i18n attributes are another dynamic-key carrier.
const htmlFile = path.join(CLIENT, 'index.html');
if (fs.existsSync(htmlFile)) {
  const html = fs.readFileSync(htmlFile, 'utf8');
  for (const m of html.matchAll(/\bdata-i18n(?:-placeholder)?=[\"']([^\"']+)[\"']/g)) {
    assertKey(m[1], htmlFile, m.index, 'html-i18n-attr');
  }
}

if (failures.length) {
  console.error('❌ i18n source-usage gate başarısız:');
  for (const failure of [...new Set(failures)]) console.error(` - ${failure}`);
  process.exit(1);
}
console.log(`✅ i18n source usage: ${tCalls} t() call, ${literalCalls} literal, ${dynamicCalls} audited dynamic; missing referenced key=0.`);
