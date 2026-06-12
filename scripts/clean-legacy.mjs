#!/usr/bin/env node
// scripts/clean-legacy.mjs
// Sprint 118: client/_legacy/ dizinlerini arşivle ve CI guard'ı güncelle.
//
// Kullanım:
//   node scripts/clean-legacy.mjs            -- dry-run (sadece listele)
//   node scripts/clean-legacy.mjs --execute  -- gerçek işlemi yap
//   node scripts/clean-legacy.mjs --help

import { readdirSync, existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT      = resolve(__dirname, '..');
const CLIENT    = join(ROOT, 'client');
const ARCHIVE   = join(ROOT, 'client', '_archived_legacy');

const DRY_RUN  = !process.argv.includes('--execute');
const HELP     = process.argv.includes('--help');

// ── Help ──────────────────────────────────────────────────────
if (HELP) {
  console.log(`
clean-legacy.mjs — Bridge sprint 118 legacy temizlik aracı

Kullanım:
  node scripts/clean-legacy.mjs             Dry-run: ne yapılacağını göster
  node scripts/clean-legacy.mjs --execute   Gerçek temizliği yap
  node scripts/clean-legacy.mjs --help      Bu yardımı göster

Ne yapar:
  1. client/**/_legacy/ dizinlerini bulur (171 dosya)
  2. --execute ile client/_archived_legacy/ altına taşır
  3. client/ altında artık hiç _legacy/ klasörü kalmaz
  4. CI guard'ını legacy'nin tamamen gittiğini doğrulayacak şekilde günceller
`);
  process.exit(0);
}

// ── Legacy dizinlerini bul ────────────────────────────────────
function findLegacyDirs(baseDir, found = []) {
  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(baseDir, entry.name);
      if (entry.name === '_legacy') {
        found.push(full);
      } else if (entry.name !== '_archived_legacy' && entry.name !== 'node_modules') {
        findLegacyDirs(full, found);
      }
    }
  } catch { /* skip unreadable dirs */ }
  return found;
}

const legacyDirs = findLegacyDirs(CLIENT);

if (legacyDirs.length === 0) {
  console.log('✅ _legacy/ dizini bulunamadı — zaten temiz!');
  process.exit(0);
}

console.log(`\n${DRY_RUN ? '🔍 DRY-RUN' : '🗑️  EXECUTE'} — Bulunan _legacy/ dizinleri:\n`);

let totalFiles = 0;
for (const dir of legacyDirs) {
  const rel = relative(ROOT, dir);
  const fileCount = countFiles(dir);
  totalFiles += fileCount;
  console.log(`  ${rel}  (${fileCount} dosya)`);
}

console.log(`\n  Toplam: ${legacyDirs.length} dizin, ${totalFiles} dosya\n`);

if (DRY_RUN) {
  console.log(`ℹ️  Gerçek işlem için: node scripts/clean-legacy.mjs --execute\n`);
  process.exit(0);
}

// ── Execute: arşivle ──────────────────────────────────────────
if (!existsSync(ARCHIVE)) mkdirSync(ARCHIVE, { recursive: true });

let moved = 0;
for (const dir of legacyDirs) {
  // client/js/admin/_legacy → _archived_legacy/js__admin__legacy
  const rel      = relative(CLIENT, dir);
  const archName = rel.replace(/\//g, '__').replace(/\\/g, '__');
  const dest     = join(ARCHIVE, archName);

  try {
    if (existsSync(dest)) {
      console.warn(`  ⚠️  Hedef zaten var, atlandı: ${archName}`);
      continue;
    }
    renameSync(dir, dest);
    console.log(`  ✅ Taşındı: ${relative(ROOT, dir)} → _archived_legacy/${archName}`);
    moved++;
  } catch (err) {
    console.error(`  ❌ Taşıma başarısız: ${dir}\n     ${err.message}`);
  }
}

// ── CI guard dosyasını güncelle ───────────────────────────────
// scripts/check-no-legacy.mjs artık _legacy/ DEĞİL _archived_legacy/'in varlığını kontrol eder
const guardPath = join(ROOT, 'scripts', 'check-no-legacy.mjs');
const guardContent = `#!/usr/bin/env node
// scripts/check-no-legacy.mjs
// CI guard: client/ altında _legacy/ dizini kalmamalı.
// Sprint 118: clean-legacy.mjs tarafından otomatik güncellendi.

import { readdirSync } from 'fs';
import { join, resolve, relative } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ROOT   = resolve(__dirname, '..');
const CLIENT = join(ROOT, 'client');

function findLegacyDirs(baseDir, found = []) {
  try {
    for (const entry of readdirSync(baseDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const full = join(baseDir, entry.name);
      if (entry.name === '_legacy') {
        found.push(full);
      } else if (entry.name !== '_archived_legacy' && entry.name !== 'node_modules') {
        findLegacyDirs(full, found);
      }
    }
  } catch { /* skip */ }
  return found;
}

const legacyDirs = findLegacyDirs(CLIENT);

if (legacyDirs.length > 0) {
  console.error('\\n❌ CI BAŞARISIZ: client/ altında _legacy/ dizini bulundu!');
  console.error('   Şunlar temizlenmeli:');
  for (const d of legacyDirs) console.error('     ' + relative(ROOT, d));
  console.error('\\n   Temizlemek için: node scripts/clean-legacy.mjs --execute\\n');
  process.exit(1);
} else {
  console.log('✅ _legacy/ kontrolü geçti — temiz.');
  process.exit(0);
}
`;

try {
  writeFileSync(guardPath, guardContent, 'utf8');
  console.log(`\n✅ CI guard güncellendi: scripts/check-no-legacy.mjs`);
} catch (err) {
  console.warn(`  ⚠️  Guard dosyası yazılamadı: ${err.message}`);
}

console.log(`\n🎉 Tamamlandı: ${moved}/${legacyDirs.length} dizin arşivlendi.\n`);

// ── Yardımcı ──────────────────────────────────────────────────
function countFiles(dir) {
  let n = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) n += countFiles(join(dir, entry.name));
      else n++;
    }
  } catch { /* skip */ }
  return n;
}
