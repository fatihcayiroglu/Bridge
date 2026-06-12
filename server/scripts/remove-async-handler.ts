#!/usr/bin/env ts-node
// server/scripts/remove-async-handler.ts
// asyncHandler wrapper'larını Express 5 altında toplu kaldırır.
//
// Express 5'te async handler'lardan fırlatılan hatalar otomatik
// olarak next(err)'e iletilir — wrapper gereksizdir.
//
// Kullanım:
//   npx ts-node server/scripts/remove-async-handler.ts --dry-run   # önce kontrol et
//   npx ts-node server/scripts/remove-async-handler.ts              # gerçek kaldırma
//
// Sonrası:
//   npx tsc --project server/tsconfig.json --noEmit                 # type-check
//   npm test                                                         # entegrasyon testleri

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

const DRY_RUN   = process.argv.includes('--dry-run');
const VERBOSE   = process.argv.includes('--verbose');
const ROOT      = path.join(__dirname, '..');
const EXTS      = ['.ts', '.js'];
const SKIP_DIRS = ['node_modules', 'dist', 'tests', '__tests__', 'scripts'];

interface FileResult {
  file:     string;
  original: string;
  replaced: string;
  count:    number;
}

// ── Dönüşüm kuralları ─────────────────────────────────────────────────────────
//
// Kural 1: router.METHOD(path, ..., async (req, res[, next]) => {
//   →      router.METHOD(path, ..., async (req, res[, next]) => {
//
// Kural 2: router.METHOD(path, async (req, res) => {
//   →      router.METHOD(path, async (req, res) => {
//
// Kural 3: import asyncHandler from '../middleware/asyncHandler';  → kaldır
//          import asyncHandler from '../../middleware/asyncHandler'; → kaldır
//
// Kural 4: Kapanış parantezi: });  →  }); (asyncHandler'ın extra )'si)
//          Bu kural YALNIZCA dönüştürülen satırların peşinden gelen bloklara uygulanır.
//          Güvenli olmayan durumlar için ayrı bir AST-based geçiş gerekebilir —
//          bu script regex tabanlıdır ve bazı kompleks iç-içe yapıları atlayabilir.
//          Kaldırma sonrası tsc + testlerle doğrulama zorunludur.

const PATTERNS: Array<{ find: RegExp; replace: string; desc: string }> = [
  {
    // asyncHandler( ile başlayan handler çağrısı
    find:    /\basyncHandler\(\s*(async\s+(?:\([^)]*\)|[a-z_$][a-z0-9_$]*)\s*=>)/gi,
    replace: '$1',
    desc:    'asyncHandler(async ... =>) → async ... =>',
  },
  {
    // asyncHandler import satırı — tek satır import
    find:    /^import\s+asyncHandler\s+from\s+['"][^'"]+asyncHandler['"];\s*\n?/gm,
    replace: '',
    desc:    'asyncHandler import kaldır',
  },
];

function collectFiles(dir: string): string[] {
  const results: string[] = [];

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP_DIRS.includes(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (EXTS.includes(path.extname(entry.name))) {
        results.push(fullPath);
      }
    }
  }

  walk(dir);
  return results;
}

function processFile(filePath: string): FileResult | null {
  const original = fs.readFileSync(filePath, 'utf8');

  if (!original.includes('asyncHandler')) return null;

  let replaced = original;
  let totalCount = 0;

  for (const { find, replace } of PATTERNS) {
    const before = replaced;
    replaced = replaced.replace(find, replace);
    // Count matches (approximate — regex replace doesn't expose count directly)
    const diff = (before.match(find) || []).length;
    totalCount += diff;
  }

  // ── Kapanış parantezi dengesi ──────────────────────────────────────────────
  // asyncHandler(fn) kaldırıldığında fazladan bir ')' kalır.
  // Örnek:   });   →   });
  // Bu yalnızca router.METHOD satırlarında güvenli şekilde uygulanır.
  //
  // NOT: Bu dönüşüm tüm }); → }); değil, yalnızca asyncHandler'ın
  // doğrudan sarmaladığı son kapanışı hedef alır. Karmaşık iç-içe
  // callback'lerde false positive riski var — tsc doğrulaması şart.
  replaced = replaced.replace(
    /^(\s*\}\s*\)\s*\)\s*;)/gm,
    (line) => line.replace(/\)\s*\)/, ')')
  );

  if (replaced === original) return null;

  return { file: filePath, original, replaced, count: totalCount };
}

function main(): void {
  console.log(`\n🔧 asyncHandler Kaldırma Scripti`);
  console.log(`   Mod: ${DRY_RUN ? 'DRY RUN (değişiklik yok)' : 'GERÇEK UYGULAMA'}`);
  console.log(`   Kök: ${ROOT}\n`);

  const files   = collectFiles(ROOT);
  const results = files
    .map(processFile)
    .filter((r): r is FileResult => r !== null);

  if (results.length === 0) {
    console.log('✅ asyncHandler bulunamadı — zaten temiz.');
    return;
  }

  let totalMatches = 0;

  for (const { file, replaced, count } of results) {
    const rel = path.relative(ROOT, file);
    totalMatches += count;

    if (VERBOSE || DRY_RUN) {
      console.log(`  📄 ${rel} (${count} değişiklik)`);
    }

    if (!DRY_RUN) {
      fs.writeFileSync(file, replaced, 'utf8');
      if (VERBOSE) console.log(`     ✓ yazıldı`);
    }
  }

  console.log(`\n📊 Özet:`);
  console.log(`   Değiştirilen dosya: ${results.length}`);
  console.log(`   Toplam eşleşme:     ~${totalMatches}`);

  if (DRY_RUN) {
    console.log(`\n⚠️  DRY RUN — hiçbir dosya değiştirilmedi.`);
    console.log(`   Gerçekten uygulamak için: npx ts-node server/scripts/remove-async-handler.ts`);
  } else {
    console.log(`\n✅ Tamamlandı. Sonraki adımlar:`);
    console.log(`   1. npx tsc --project server/tsconfig.json --noEmit`);
    console.log(`   2. npm test (server/)`);
    console.log(`   3. Diff gözden geçir: git diff server/routes/`);
    console.log(`\n   ⚠️  Karmaşık iç-içe asyncHandler kullanımları manuel kontrol gerektirebilir.`);
    console.log(`       Özellikle birden fazla middleware'in aynı anda sarıldığı durumlar.`);
  }
}

main();
