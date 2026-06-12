#!/usr/bin/env node
// scripts/merge-openapi.mjs
// Sprint 118: openapi-additions-s118.yaml'ı ana openapi.yaml'a merge eder.
//
// Kullanım:
//   node scripts/merge-openapi.mjs                          # varsayılan dosyalar
//   node scripts/merge-openapi.mjs base.yaml additions.yaml # özel dosyalar
//
// Strateji:
//   - paths: deep merge (var olan path'ler korunur, yeniler eklenir)
//   - components.schemas: deep merge
//   - Diğer alanlar (info, servers, tags): base korunur

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const BASE_PATH      = process.argv[2] ?? resolve(ROOT, 'docs/api/openapi.yaml');
const ADDITIONS_PATH = process.argv[3] ?? resolve(ROOT, 'docs/api/openapi-additions-s118.yaml');

// ── yaml 依存なし — シンプルな正規表現ベースのマージ ──────────────
// (yaml 라이브러리 없이 동작하도록 간단 텍스트 머지 + Node.js yaml 모듈 사용)
// Node.js 22에서 실험적 --experimental-vm-modules 없이도 동작

let yaml;
try {
  // Try built-in (Node.js 22 has no built-in yaml)
  yaml = await import('yaml');
} catch {
  console.error('❌ "yaml" paketi bulunamadı. Kurmak için: npm install yaml');
  console.error('   Alternatif: manuel olarak openapi-additions-s118.yaml içeriğini openapi.yaml\'a ekleyin.');
  process.exit(1);
}

const { parse, stringify } = yaml.default ?? yaml;

// ── Dosyaları oku ─────────────────────────────────────────────
let base, additions;
try {
  base      = parse(readFileSync(BASE_PATH, 'utf8'));
  additions = parse(readFileSync(ADDITIONS_PATH, 'utf8'));
} catch (err) {
  console.error(`❌ Dosya okuma hatası: ${err.message}`);
  process.exit(1);
}

// ── Paths merge ───────────────────────────────────────────────
base.paths = base.paths ?? {};
for (const [path, methods] of Object.entries(additions.paths ?? {})) {
  if (base.paths[path]) {
    // Var olan path'e yeni method'ları ekle (override etme)
    base.paths[path] = { ...methods, ...base.paths[path] };
    console.log(`  ↩ Mevcut path güncellendi: ${path}`);
  } else {
    base.paths[path] = methods;
    console.log(`  ✅ Yeni path eklendi: ${path}`);
  }
}

// ── Components.schemas merge ──────────────────────────────────
base.components         = base.components ?? {};
base.components.schemas = base.components.schemas ?? {};
for (const [name, schema] of Object.entries(additions.components?.schemas ?? {})) {
  if (base.components.schemas[name]) {
    console.log(`  ↩ Mevcut schema korundu (override edilmedi): ${name}`);
  } else {
    base.components.schemas[name] = schema;
    console.log(`  ✅ Yeni schema eklendi: ${name}`);
  }
}

// ── Tags merge (varsa) ────────────────────────────────────────
if (additions.tags) {
  base.tags = base.tags ?? [];
  const existingTagNames = new Set(base.tags.map((t) => t.name));
  for (const tag of additions.tags) {
    if (!existingTagNames.has(tag.name)) {
      base.tags.push(tag);
      console.log(`  ✅ Yeni tag eklendi: ${tag.name}`);
    }
  }
}

// ── Çıktıya yaz ───────────────────────────────────────────────
const output = stringify(base, { lineWidth: 120, defaultKeyType: 'PLAIN' });
writeFileSync(BASE_PATH, output, 'utf8');

console.log(`\n✅ Merge tamamlandı → ${BASE_PATH}`);
console.log(`   Toplam path: ${Object.keys(base.paths).length}`);
console.log(`   Toplam schema: ${Object.keys(base.components.schemas).length}`);
