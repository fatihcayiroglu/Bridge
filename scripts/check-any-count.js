#!/usr/bin/env node
// scripts/check-any-count.js
//
// CI kalite geçidi — client TypeScript dosyalarındaki `any` sayısını kontrol eder.
//
// Kullanım:
//   node scripts/check-any-count.js           # varsayılan eşik (CEILING)
//   node scripts/check-any-count.js --update  # mevcut sayıyı baseline olarak yaz
//   node scripts/check-any-count.js --diff    # dosya bazlı artan/azalan listesi
//
// CI entegrasyonu (package.json):
//   "lint:any": "node scripts/check-any-count.js"
//
// Strateji:
//   - Her PR'da sayı CEILING'i aşamaz (yeni any eklenmesini önler)
//   - Sayı azaldıkça CEILING düşürülebilir (kademeli iyileştirme)
//   - --update bayrağı ile baseline.json güncellenir

'use strict';

const fs   = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── Yapılandırma ─────────────────────────────────────────────────────────────
const CLIENT_DIR     = path.resolve(__dirname, '../client/js');
const SERVER_DIR     = path.resolve(__dirname, '../server');
const BASELINE_FILE  = path.resolve(__dirname, '../client/.any-baseline.json');

// Sprint 80: client any = 0. Sprint 110: server any = 0 — her iki taraf sıfır.
const CEILING = 0;

// Server test/mock dizinleri hariç tutulur
const SERVER_EXCLUDE = new Set(['tests', '__mocks__', '__tests__']);

// ── Pattern'lar ───────────────────────────────────────────────────────────────
const ANY_PATTERNS = [
  /:\s*any\b/,       // tip annotation: any
  /\bas\s+any\b/,    // type assertion: as any
  /<any>/,           // generic: <any>
];

function countInFile(filePath) {
  let count = 0;
  try {
    const lines = fs.readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      // Tek satırlık yorumları atla
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) continue;
      for (const pattern of ANY_PATTERNS) {
        if (pattern.test(line)) count++;
      }
    }
  } catch { /* okunamıyorsa say */ }
  return count;
}

function collectTsFiles(dir, excludeDirs = new Set()) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!excludeDirs.has(entry.name)) results.push(...collectTsFiles(path.join(dir, entry.name), excludeDirs));
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(path.join(dir, entry.name));
    }
  }
  return results;
}

function buildReport() {
  const clientFiles = collectTsFiles(CLIENT_DIR);
  const serverFiles = collectTsFiles(SERVER_DIR, SERVER_EXCLUDE);
  const files   = [...clientFiles, ...serverFiles];
  const byFile  = {};
  let total     = 0;
  for (const f of files) {
    const count = countInFile(f);
    if (count > 0) {
      byFile[path.relative(process.cwd(), f)] = count;
      total += count;
    }
  }
  return { total, byFile };
}

// ── Komut satırı ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args.includes('--update')) {
  const { total, byFile } = buildReport();
  fs.writeFileSync(BASELINE_FILE, JSON.stringify({ total, byFile, updatedAt: new Date().toISOString() }, null, 2));
  console.log(`✅ Baseline güncellendi: ${total} any (${Object.keys(byFile).length} dosya)`);
  process.exit(0);
}

if (args.includes('--diff')) {
  const { total, byFile } = buildReport();
  let baseline = {};
  try { baseline = JSON.parse(fs.readFileSync(BASELINE_FILE, 'utf8')).byFile || {}; } catch {}
  const allFiles = new Set([...Object.keys(byFile), ...Object.keys(baseline)]);
  const rows = [];
  for (const f of allFiles) {
    const now  = byFile[f]  || 0;
    const prev = baseline[f] || 0;
    if (now !== prev) rows.push({ file: f, prev, now, delta: now - prev });
  }
  rows.sort((a, b) => b.delta - a.delta);
  if (rows.length === 0) {
    console.log('✅ Baseline\'den bu yana any sayısında değişiklik yok.');
  } else {
    console.log('any değişimleri (önceki → şimdi):');
    for (const r of rows) {
      const sign = r.delta > 0 ? `+${r.delta}` : `${r.delta}`;
      console.log(`  ${sign.padStart(4)}  ${r.prev} → ${r.now}  ${r.file}`);
    }
  }
  console.log(`\nToplam: ${total} any`);
  process.exit(0);
}

// ── Normal CI kontrolü ────────────────────────────────────────────────────────
const { total, byFile } = buildReport();

console.log(`\n📊 Client TypeScript 'any' sayısı: ${total} / ${CEILING} (eşik)\n`);

if (total > CEILING) {
  console.error(`❌ BAŞARISIZ: ${total} any > ${CEILING} eşik`);
  console.error(`   Yeni any eklendi veya CEILING güncellenmedi.`);
  console.error(`   En fazla any içeren dosyalar:`);
  Object.entries(byFile)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .forEach(([f, n]) => console.error(`     ${String(n).padStart(4)}  ${f}`));
  process.exit(1);
}

const saved = CEILING - total;
console.log(`✅ BAŞARILI: ${total} any ≤ ${CEILING} eşik (${saved} azaltılabilecek daha var)`);

// En kötü dosyaları göster (teknik borç hatırlatıcısı)
const top = Object.entries(byFile).sort((a, b) => b[1] - a[1]).slice(0, 5);
if (top.length > 0) {
  console.log('\nTeknik borç — en fazla any içeren dosyalar:');
  top.forEach(([f, n]) => console.log(`  ${String(n).padStart(4)}  ${f}`));
  console.log('\nBu dosyalardaki any\'leri azaltmak CEILING\'i düşürmenizi sağlar.');
}
