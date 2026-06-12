#!/usr/bin/env ts-node
/**
 * server/scripts/migrate-tests-to-ts.ts
 *
 * server/tests/**‌/*.test.js dosyalarını TypeScript'e dönüştürür.
 *
 * Dönüşüm kuralları:
 *   1. require()  → import (named + default)
 *   2. jest.fn()  → jest.fn() (tip annotasyonu eklenir)
 *   3. process.env atamalarında as const eklenir
 *   4. Dosya .ts olarak kaydedilir
 *   5. Orijinal .js dosyası silinir (--keep-js ile korunabilir)
 *
 * Kullanım:
 *   npx ts-node server/scripts/migrate-tests-to-ts.ts --dry-run
 *   npx ts-node server/scripts/migrate-tests-to-ts.ts
 *   npx ts-node server/scripts/migrate-tests-to-ts.ts --keep-js
 *
 * Sonrası:
 *   npx tsc --project server/tsconfig.jest.json --noEmit
 *   npm test
 */

import fs   from 'fs';
import path from 'path';

const DRY_RUN  = process.argv.includes('--dry-run');
const KEEP_JS  = process.argv.includes('--keep-js');
const VERBOSE  = process.argv.includes('--verbose');
const TESTS_DIR = path.join(__dirname, '..', 'tests');

interface FileResult {
  file:    string;
  changes: string[];
}

// ── Dönüşüm kuralları ─────────────────────────────────────────────────────────

function transformContent(src: string, filePath: string): { out: string; changes: string[] } {
  let out     = src;
  const changes: string[] = [];

  // 1. Shebang / env ayarları — as const değil, bırak
  //    process.env.X = 'Y'  kalsın (test setup için gerekli)

  // 2. const { a, b } = require('mod')  →  import { a, b } from 'mod'
  out = out.replace(
    /^const\s+\{\s*([^}]+)\s*\}\s*=\s*require\(['"]([^'"]+)['"]\);?/gm,
    (_m, names: string, mod: string) => {
      const cleaned = names.split(',').map((n: string) => n.trim()).join(', ');
      changes.push(`require → import { ${cleaned} } from '${mod}'`);
      return `import { ${cleaned} } from '${mod}';`;
    }
  );

  // 3. const Foo = require('mod')  →  import Foo from 'mod'
  out = out.replace(
    /^const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\);?/gm,
    (_m, name: string, mod: string) => {
      changes.push(`require → import ${name} from '${mod}'`);
      return `import ${name} from '${mod}';`;
    }
  );

  // 4. jest.mock('mod', () => ({ ... }))  — bırak, TypeScript'te de çalışır

  // 5. Açık any'ler için tip kastları — fonksiyon parametrelerinde implicit any
  //    err, req, res, next  →  Express tiplerine bind etmek zor, genel bırak
  //    Ama en azından import type ekleyelim (supertest kullananlar için)
  if (out.includes("require('supertest')") || out.includes('from \'supertest\'')) {
    if (!out.includes('import type') && !out.includes("from 'supertest'")) {
      out = `import type { SuperTest, Test } from 'supertest';\n` + out;
      changes.push('added supertest type import');
    }
  }

  // 6. Dosya başındaki // comment'i .ts olarak güncelle
  out = out.replace(
    /^(\/\/ server\/tests\/)([^\n]+\.test)\.js/,
    '$1$2.ts'
  );
  if (out.match(/^\/\/ server\/tests\//)) changes.push('header yorum güncellendi');

  // 7. module.exports  → export default (nadiren test dosyasında olur)
  out = out.replace(
    /module\.exports\s*=\s*/g,
    'export default '
  );

  // 8. any tipli değişkenlere tip annotasyonu (beforeAll'daki let x; → let x: string;)
  //    refreshToken gibi string değişkenler
  out = out.replace(
    /^\s+let\s+(\w+);\s*$/gm,
    (m, name: string) => {
      if (['refreshToken', 'token', 'cookie', 'sessionId'].includes(name)) {
        changes.push(`let ${name} → let ${name}: string`);
        return m.replace(`let ${name};`, `let ${name}: string;`);
      }
      return m;
    }
  );

  return { out, changes };
}

// ── Dosya listesi ─────────────────────────────────────────────────────────────

function findTestJs(dir: string): string[] {
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.test.js'))
    .map(f => path.join(dir, f));
}

// ── Ana işlem ─────────────────────────────────────────────────────────────────

function main(): void {
  const files = findTestJs(TESTS_DIR);
  console.log(`\n🔍 Bulunan .test.js dosyası: ${files.length}\n`);

  const results: FileResult[] = [];
  let converted = 0;

  for (const jsFile of files) {
    const tsFile = jsFile.replace(/\.test\.js$/, '.test.ts');

    if (fs.existsSync(tsFile)) {
      if (VERBOSE) console.log(`  ⏭  Atlandı (ts zaten var): ${path.basename(jsFile)}`);
      continue;
    }

    const src = fs.readFileSync(jsFile, 'utf8');
    const { out, changes } = transformContent(src, jsFile);

    results.push({ file: path.basename(tsFile), changes });

    if (!DRY_RUN) {
      fs.writeFileSync(tsFile, out, 'utf8');
      if (!KEEP_JS) fs.unlinkSync(jsFile);
    }

    converted++;
    console.log(`  ✅ ${path.basename(tsFile)} (${changes.length} değişiklik)`);
    if (VERBOSE) changes.forEach(c => console.log(`      • ${c}`));
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Dönüştürülen: ${converted} / ${files.length}`);
  if (DRY_RUN) console.log('⚠️  DRY-RUN — dosya yazılmadı.');
  console.log(`\nSonraki adımlar:`);
  console.log(`  npx tsc --project server/tsconfig.jest.json --noEmit`);
  console.log(`  npm test\n`);
}

main();
