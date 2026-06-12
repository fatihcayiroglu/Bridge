#!/usr/bin/env node
// scripts/check-no-legacy.mjs
// CI structural guard: aktif kaynak dizinlerinde _legacy/ klasörü kalmamasını doğrular.
// _archived_legacy/ dizinleri muaf tutulur (bunlar arşivdir, aktif kod değil).
//
// Kullanım: node scripts/check-no-legacy.mjs
// CI: package.json scripts → "check:legacy"

import { readdirSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(__dirname, '..');

// Bu dizinlerde _legacy/ aranır (aktif kaynak dizinleri)
const SEARCH_ROOTS = [
  join(ROOT, 'client', 'js'),
  join(ROOT, 'server'),
  join(ROOT, 'electron'),
  join(ROOT, 'mobile'),
  join(ROOT, 'plugins'),
  join(ROOT, 'bot-sdk'),
  join(ROOT, 'discord-shim', 'src'),
];

function findLegacyDirs(dir, results = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    // _archived_legacy geçen her şeyi atla — bunlar arşiv
    if (entry.name === '_archived_legacy') continue;
    if (entry.name === 'node_modules') continue;
    if (entry.name === '_legacy') {
      results.push(full);
      continue;
    }
    findLegacyDirs(full, results);
  }
  return results;
}

const found = SEARCH_ROOTS.flatMap(r => existsSync(r) ? findLegacyDirs(r) : []);

if (found.length > 0) {
  console.error('❌ _legacy/ klasörleri aktif kaynak dizinlerinde bulundu:');
  found.forEach(f => console.error('  -', f));
  console.error('\nDüzeltme: node scripts/clean-legacy.mjs --execute');
  process.exit(1);
}

console.log('✅ Aktif dizinlerde _legacy/ klasörü yok. Temiz.');
process.exit(0);
