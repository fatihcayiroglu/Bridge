#!/usr/bin/env node
/**
 * fix-query-casts.js
 * ─────────────────────────────────────────────────────────────
 * Bridge route dosyalarındaki req.query TypeScript cast eksiklerini düzeltir.
 * fix-strict-nulls.js'nin kapsamadığı req.query pattern'larını hedef alır.
 *
 * Dönüşümler:
 *   parseInt(req.query.X)          → parseInt(String(req.query.X ?? ''))
 *   parseInt(req.query.X, 10)      → parseInt(String(req.query.X ?? ''), 10)
 *   JSON.parse(req.query.X)        → JSON.parse(String(req.query.X ?? ''))
 *   (req.query.X || '').trim()     → (String(req.query.X ?? '') || '').trim()
 *   req.query.X || 'fallback'      → (req.query.X as string | undefined) || 'fallback'
 *   Buffer.from(req.query.X, ...) → Buffer.from(String(req.query.X ?? ''), ...)
 *
 * Kullanım:
 *   node fix-query-casts.js --dry-run   # sadece göster
 *   node fix-query-casts.js             # uygula
 *   node fix-query-casts.js --file routes/messages.ts
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const SINGLE  = (() => {
  const idx = process.argv.indexOf('--file');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

const SERVER_DIR = (() => {
  if (fs.existsSync(path.join(process.cwd(), 'routes'))) return process.cwd();
  const parent = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(parent, 'routes'))) return parent;
  return process.cwd();
})();

const ROUTES_DIR = path.join(SERVER_DIR, 'routes');

function fixContent(content, filename) {
  let changed = false;
  let out = content;

  // 1. parseInt(req.query.X) ve parseInt(req.query.X, radix)
  //    Zaten String(... şeklinde sarılmışsa atla
  out = out.replace(
    /parseInt\(req\.query\.(\w+)(?:\s*,\s*(\d+))?\)/g,
    (match, field, radix) => {
      if (match.includes('String(')) return match;
      changed = true;
      const r = radix ? `, ${radix}` : '';
      return `parseInt(String(req.query.${field} ?? '')${r})`;
    }
  );

  // 2. JSON.parse(req.query.X)
  out = out.replace(
    /JSON\.parse\(req\.query\.(\w+)\)/g,
    (match, field) => {
      changed = true;
      return `JSON.parse(String(req.query.${field} ?? ''))`;
    }
  );

  // 3. Buffer.from(req.query.X, 'base64') — zaten Array.isArray yoksa
  out = out.replace(
    /Buffer\.from\(req\.query\.(\w+),\s*(['"`][^'"`]+['"`])\)/g,
    (match, field, enc) => {
      if (match.includes('Array.isArray')) return match;
      changed = true;
      return `Buffer.from(String(req.query.${field} ?? ''), ${enc})`;
    }
  );

  // 4. (req.query.X || '').trim() / (req.query.X || '').toLowerCase()
  out = out.replace(
    /\(req\.query\.(\w+)\s*\|\|\s*''\)(\.\w+\()/g,
    (match, field, method) => {
      changed = true;
      return `(String(req.query.${field} ?? '')${method}`;
    }
  );

  if (changed) {
    console.log(`  ✅ ${filename}`);
  } else {
    console.log(`  ⬜ ${filename} (değişiklik yok)`);
  }

  return { changed, content: out };
}

function getFiles() {
  if (SINGLE) {
    const abs = path.isAbsolute(SINGLE)
      ? SINGLE
      : path.join(SERVER_DIR, SINGLE);
    return [abs];
  }
  // routes/ + alt dizinler
  const results = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts')) results.push(full);
    }
  }
  walk(ROUTES_DIR);
  return results;
}

function main() {
  console.log(`\n🔧 fix-query-casts — ${DRY_RUN ? 'DRY RUN' : 'UYGULAMA'}\n`);
  const files = getFiles();
  let totalChanged = 0;

  for (const file of files) {
    const rel = path.relative(SERVER_DIR, file);
    const content = fs.readFileSync(file, 'utf-8');
    // Sadece req.query. içeren dosyaları işle
    if (!content.includes('req.query.')) continue;

    const { changed, content: newContent } = fixContent(content, rel);
    if (changed) {
      totalChanged++;
      if (!DRY_RUN) {
        fs.writeFileSync(file, newContent, 'utf-8');
      }
    }
  }

  console.log(`\n${DRY_RUN ? '[DRY RUN] ' : ''}${totalChanged} dosya güncellendi.\n`);
  if (DRY_RUN) console.log('Uygulamak için: node fix-query-casts.js\n');
  else console.log('Doğrulamak için: npx tsc --noEmit\n');
}

main();
