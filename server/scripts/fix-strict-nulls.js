#!/usr/bin/env node
/**
 * fix-strict-nulls.ts
 * ─────────────────────────────────────────────────────────────
 * Bridge route dosyalarındaki strictNullChecks hatalarını
 * toplu olarak düzeltir.
 *
 * Ne yapar:
 *   1. Her .ts route dosyasında `req.user.` erişimlerini tespit eder
 *   2. `castAuthed` import'unu ekler (zaten varsa atlar)
 *   3. req.user.X → castAuthed(req).user.X dönüşümü yapar
 *   4. parseInt(req.query.X) → parseInt(String(req.query.X ?? '')) düzeltir
 *   5. Buffer.from(req.query.X, 'base64') güvenli hale getirir
 *
 * Kullanım:
 *   node fix-strict-nulls.js --dry-run   # sadece göster, yazma
 *   node fix-strict-nulls.js             # uygula
 *   node fix-strict-nulls.js --file routes/servers.ts  # tek dosya
 *
 * Sonra doğrula:
 *   npx tsc --noEmit
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ── Config ─────────────────────────────────────────────────────
const DRY_RUN    = process.argv.includes('--dry-run');
const SINGLE     = (() => {
  const idx = process.argv.indexOf('--file');
  return idx !== -1 ? process.argv[idx + 1] : null;
})();

// Script kendi konumuna göre değil, cwd'e göre çalışır
// Hem `node scripts/fix-strict-nulls.js` hem `node fix-strict-nulls.js` için
const SERVER_DIR = (() => {
  // Önce cwd içinde routes/ var mı bak
  if (fs.existsSync(path.join(process.cwd(), 'routes'))) return process.cwd();
  // Sonra script'in bir üst dizinine bak (scripts/ klasöründeyse)
  const parent = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(parent, 'routes'))) return parent;
  // Doğrudan verilen argüman
  const serverArg = process.argv.find(a => a.startsWith('--server='));
  if (serverArg) return serverArg.replace('--server=', '');
  return process.cwd();
})();
const ROUTES_DIR = path.join(SERVER_DIR, 'routes');

const CASTAUTHED_IMPORT = `import { castAuthed } from '../middleware/auth';`;
const CASTAUTHED_IMPORT_REGEX = /import\s+\{[^}]*castAuthed[^}]*\}\s+from\s+['"]\.\.\/middleware\/auth['"]/;

// ── Helpers ────────────────────────────────────────────────────

function log(msg) { console.log(msg); }
function info(msg) { console.log(`  ℹ️  ${msg}`); }
function ok(msg)   { console.log(`  ✅ ${msg}`); }
function skip(msg) { console.log(`  ⬜ ${msg}`); }
function warn(msg) { console.log(`  ⚠️  ${msg}`); }

/**
 * Dosyaya castAuthed import ekler.
 * - Zaten varsa dokunmaz
 * - auth import'u varsa onun yanına ekler
 * - Yoksa dosyanın başına ekler
 */
function addCastAuthedImport(content) {
  // Zaten var mı?
  if (CASTAUTHED_IMPORT_REGEX.test(content)) return { changed: false, content };

  // Mevcut auth import'una castAuthed ekle
  // import { authMiddleware } from '../middleware/auth'
  // import { authMiddleware, makeToken } from '../middleware/auth'
  const authImportMatch = content.match(
    /import\s+\{([^}]+)\}\s+from\s+['"]\.\.\/middleware\/auth['"]/
  );
  if (authImportMatch) {
    const existingImports = authImportMatch[1];
    if (!existingImports.includes('castAuthed')) {
      const newImport = `import { ${existingImports.trim()}, castAuthed } from '../middleware/auth'`;
      return {
        changed: true,
        content: content.replace(authImportMatch[0], newImport),
      };
    }
    return { changed: false, content };
  }

  // require('../middleware/auth') satırının ardına ekle
  const requireAuthMatch = content.match(
    /^(.*require\(['"]\.\.\/middleware\/auth['"]\).*\n)/m
  );
  if (requireAuthMatch) {
    return {
      changed: true,
      content: content.replace(
        requireAuthMatch[0],
        requireAuthMatch[0] + CASTAUTHED_IMPORT + '\n'
      ),
    };
  }

  // Hiç auth import yoksa dosyanın en başına ekle (ilk import'tan önce)
  const firstImport = content.match(/^(import |const .* = require)/m);
  if (firstImport) {
    const idx = content.indexOf(firstImport[0]);
    return {
      changed: true,
      content: content.slice(0, idx) + CASTAUTHED_IMPORT + '\n' + content.slice(idx),
    };
  }

  // En başa ekle
  return { changed: true, content: CASTAUTHED_IMPORT + '\n\n' + content };
}

/**
 * asyncHandler callback'lerinde req.user.X → castAuthed(req).user.X
 *
 * Sadece `async (req, res)` veya `async (req, res, next)` imzalı
 * handler içindeki kullanımları dönüştürür.
 */
function fixReqUser(content) {
  let changed = false;
  // Basit pattern: req.user. → castAuthed(req).user.
  // Ama req.user? (optional chain), req.user === undefined gibi kontrolleri korur
  const result = content.replace(
    /\breq\.user\.(id|username|v|iat|exp|displayName|tokenVersion)\b/g,
    (match, field) => {
      changed = true;
      return `castAuthed(req).user.${field}`;
    }
  );
  return { changed, content: result };
}

/**
 * parseInt(req.query.X) → parseInt(String(req.query.X ?? ''))
 */
function fixParseIntQuery(content) {
  let changed = false;
  const result = content.replace(
    /parseInt\(\s*req\.query\.([a-zA-Z_]+)\s*\)/g,
    (match, field) => {
      changed = true;
      return `parseInt(String(req.query.${field} ?? ''))`;
    }
  );
  return { changed, content: result };
}

/**
 * Buffer.from(req.query.X, 'base64') →
 * Buffer.from(Array.isArray(req.query.X) ? req.query.X[0]! : req.query.X!, 'base64')
 *
 * Bu dönüşüm agresif — sadece açık `req.query` Buffer kullanımları için
 */
function fixBufferFromQuery(content) {
  let changed = false;
  const result = content.replace(
    /Buffer\.from\(\s*req\.query\.([a-zA-Z_]+)\s*,\s*['"]base64['"]\s*\)/g,
    (match, field) => {
      changed = true;
      return `Buffer.from((Array.isArray(req.query.${field}) ? req.query.${field}[0] : req.query.${field}) ?? '', 'base64')`;
    }
  );
  return { changed, content: result };
}

/**
 * req.query.X.trim() → (req.query.X as string)?.trim()
 * req.query.X?.trim() → (req.query.X as string | undefined)?.trim()
 */
function fixQueryMethodCalls(content) {
  let changed = false;
  // req.query.X.trim() veya req.query.X?.trim()
  const result = content.replace(
    /\breq\.query\.([a-zA-Z_]+)(\.|\?\.)(trim|toLowerCase|toUpperCase|slice|split)\(/g,
    (match, field, dot, method) => {
      changed = true;
      return `(req.query.${field} as string | undefined)?.${method}(`;
    }
  );
  return { changed, content: result };
}

// ── Ana işlem ─────────────────────────────────────────────────

function processFile(filePath) {
  const rel = path.relative(SERVER_DIR, filePath);
  let content = fs.readFileSync(filePath, 'utf8');
  const original = content;
  let anyChange = false;

  // req.user kullanımı var mı kontrol et
  const hasReqUser = /req\.user\./.test(content);
  const hasQueryIssues = /parseInt\(req\.query|Buffer\.from\(req\.query|req\.query\.[a-z]+\./.test(content);

  if (!hasReqUser && !hasQueryIssues) {
    skip(`${rel} — req.user veya query sorunu yok`);
    return { file: rel, changed: false };
  }

  // 1. castAuthed import ekle (req.user varsa)
  if (hasReqUser) {
    const r = addCastAuthedImport(content);
    if (r.changed) { content = r.content; anyChange = true; }
  }

  // 2. req.user.X düzelt
  if (hasReqUser) {
    const r = fixReqUser(content);
    if (r.changed) { content = r.content; anyChange = true; }
  }

  // 3. parseInt(req.query.X) düzelt
  {
    const r = fixParseIntQuery(content);
    if (r.changed) { content = r.content; anyChange = true; }
  }

  // 4. Buffer.from(req.query.X) düzelt
  {
    const r = fixBufferFromQuery(content);
    if (r.changed) { content = r.content; anyChange = true; }
  }

  // 5. req.query.X.method() düzelt
  {
    const r = fixQueryMethodCalls(content);
    if (r.changed) { content = r.content; anyChange = true; }
  }

  if (!anyChange) {
    skip(`${rel} — değişiklik gerekmedi`);
    return { file: rel, changed: false };
  }

  if (DRY_RUN) {
    ok(`${rel} — ${countDiff(original, content)} değişiklik (DRY RUN)`);
  } else {
    fs.writeFileSync(filePath, content, 'utf8');
    ok(`${rel} — ${countDiff(original, content)} değişiklik yazıldı`);
  }

  return { file: rel, changed: true, original, updated: content };
}

function countDiff(a, b) {
  const aLines = a.split('\n');
  const bLines = b.split('\n');
  let count = 0;
  const maxLen = Math.max(aLines.length, bLines.length);
  for (let i = 0; i < maxLen; i++) {
    if (aLines[i] !== bLines[i]) count++;
  }
  return count;
}

function getRouteFiles() {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(full);
      }
    }
  }
  walk(ROUTES_DIR);
  return files;
}

// ── Entry point ───────────────────────────────────────────────

function main() {
  console.log('\n🔧 Bridge — strictNullChecks Route Düzeltici');
  if (DRY_RUN) console.log('   ⚠️  DRY RUN — dosyalara yazılmaz\n');

  let files;
  if (SINGLE) {
    const full = path.resolve(SERVER_DIR, SINGLE);
    if (!fs.existsSync(full)) {
      console.error(`❌ Dosya bulunamadı: ${full}`);
      process.exit(1);
    }
    files = [full];
  } else {
    files = getRouteFiles();
  }

  console.log(`📁 ${files.length} route dosyası taranıyor...\n`);

  let changed = 0;
  const results = files.map(f => processFile(f));
  changed = results.filter(r => r.changed).length;

  console.log('\n' + '─'.repeat(50));
  console.log(`✅ Tamamlandı: ${changed}/${files.length} dosya ${DRY_RUN ? 'değişirdi' : 'güncellendi'}`);

  if (!DRY_RUN && changed > 0) {
    console.log('\n📌 Sonraki adım — TypeScript doğrulama:');
    console.log('   npx tsc --noEmit');
    console.log('   npx tsc --noEmit --project tsconfig.session15.json');
  }

  if (DRY_RUN) {
    console.log('\n💡 Değişiklikleri uygulamak için --dry-run olmadan çalıştır:');
    console.log('   node fix-strict-nulls.js');
  }
}

main();
