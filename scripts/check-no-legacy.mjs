#!/usr/bin/env node
// scripts/check-no-legacy.mjs
// CI structural guard: release source tree içinde legacy/arşiv kaynak klasörü kalmamasını doğrular.
// Tarihsel implementasyonlar VCS history'de kalır; dağıtılan source tree'ye taşınmaz.
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

const FORBIDDEN_DIRECTORY_NAMES = new Set([
  '_legacy',
  '_archived_legacy',
  'tests-legacy',
  'workflows.disabled',
]);

const FORBIDDEN_RELATIVE_PATHS = new Set([
  'client/.storybook',
  'ui',
  'client/stories',
  'client/tsconfig.strict-gate.json',
  'client/tests/package.json',
  'client/tests/babel.config.js',
  'client/tests/helpers/setup.ts',
  'client/tests/helpers/canvas-mock.ts',
  'client/vitest.config.ts',
  'server/package.json.presfu',
  'fix-all-imports.sh',
  'fix-imports.sh',
  'fix-registry-calls.sh',
]);

function isForbiddenFile(name) {
  const lower = name.toLocaleLowerCase('en-US');
  return lower.includes('._deprecated.') || /(?:^|[._-])deprecated(?:[._-]|$)/.test(lower);
}

function findForbiddenEntries(dir, results = []) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return results; }

  for (const entry of entries) {
    const full = join(dir, entry.name);
    const relative = full.slice(ROOT.length + 1).split('\\').join('/');
    if (FORBIDDEN_RELATIVE_PATHS.has(relative)) {
      results.push(full);
      continue;
    }
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      if (FORBIDDEN_DIRECTORY_NAMES.has(entry.name)
          || (entry.name === 'disabled' && full.includes(`${join(ROOT, '.github')}${process.platform === 'win32' ? '\\' : '/'}`))) {
        results.push(full);
        continue;
      }
      findForbiddenEntries(full, results);
      continue;
    }
    if (entry.isFile() && isForbiddenFile(entry.name)) results.push(full);
  }
  return results;
}

const SEARCH_TREE_ROOTS = [ROOT];
const found = SEARCH_TREE_ROOTS.flatMap(r => existsSync(r) ? findForbiddenEntries(r) : []);

if (found.length > 0) {
  console.error('❌ Deprecated/legacy/disabled kaynak release tree içinde bulundu:');
  found.forEach(f => console.error('  -', f));
  console.error('\nTarihsel kaynakları release tree’den kaldırın; gerekirse VCS history’den erişin.');
  process.exit(1);
}

console.log('✅ Release tree deprecated/legacy/disabled kaynak içermiyor.');
process.exit(0);
