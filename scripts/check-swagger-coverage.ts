#!/usr/bin/env ts-node
// scripts/check-swagger-coverage.ts
// Swagger/OpenAPI annotation kapsam kontrolü.
//
// Kullanım:
//   npx ts-node scripts/check-swagger-coverage.ts           # özet rapor
//   npx ts-node scripts/check-swagger-coverage.ts --detail  # dosya bazlı detay
//   npx ts-node scripts/check-swagger-coverage.ts --ci      # CI modunda çalış (threshold hatası)
//
// CI entegrasyonu (.github/workflows/ci.yml):
//   - name: Swagger coverage
//     run: npx ts-node scripts/check-swagger-coverage.ts --ci

import fs   from 'fs';
import path from 'path';

// __dirname ile çözülür — hangi dizinden çalıştırılırsa çalıştırılsın doğru çalışır.
// Eski: process.cwd() tabanlıydı; CI'da server/ cwd'si yanlış path üretiyordu.
const scriptDir = path.resolve(__dirname);

const DETAIL   = process.argv.includes('--detail');
const CI_MODE  = process.argv.includes('--ci');
// Minimum kabul edilebilir kapsam — hedef %90
const MIN_COVERAGE_PCT = 90;

interface RouteFile {
  relPath:       string;
  routeCount:    number;
  hasAnnotation: boolean;
}

// ── Yardımcı ─────────────────────────────────────────────────────────────────

function collectRouteFiles(dir: string): RouteFile[] {
  const results: RouteFile[] = [];
  const SKIP = new Set(['node_modules', 'dist', '__tests__']);

  function walk(current: string): void {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      if (SKIP.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
        const content = fs.readFileSync(full, 'utf-8');
        const routeCount = (content.match(/router\.(get|post|patch|put|delete|all)\s*\(/g) || []).length;
        if (routeCount === 0) continue;

        const hasAnnotation = content.includes('@openapi') || content.includes('@swagger');
        results.push({
          relPath:    path.relative(dir, full),
          routeCount,
          hasAnnotation,
        });
      }
    }
  }

  walk(dir);
  return results;
}

// ── Ana rapor ─────────────────────────────────────────────────────────────────

const ROUTES_DIR = path.join(scriptDir, '../server/routes');
const files      = collectRouteFiles(ROUTES_DIR);

const totalFiles      = files.length;
const annotatedFiles  = files.filter(f => f.hasAnnotation).length;
const totalRoutes     = files.reduce((s, f) => s + f.routeCount, 0);
// Annotated dosyalardaki route sayısı (yaklaşım)
const annotatedRoutes = files
  .filter(f => f.hasAnnotation)
  .reduce((s, f) => s + f.routeCount, 0);

const fileCoverage  = totalFiles  > 0 ? Math.round(annotatedFiles  / totalFiles  * 100) : 0;
const routeCoverage = totalRoutes > 0 ? Math.round(annotatedRoutes / totalRoutes * 100) : 0;

console.log('\n📊 Swagger / OpenAPI Kapsam Raporu');
console.log('─'.repeat(50));
console.log(`Annotasyonlu dosya : ${annotatedFiles} / ${totalFiles}  (${fileCoverage}%)`);
console.log(`Tahmini route kapsam: ${annotatedRoutes} / ${totalRoutes}  (${routeCoverage}%)`);
console.log(`CI eşiği            : ${MIN_COVERAGE_PCT}%`);

if (DETAIL) {
  console.log('\n── Annotasyonlu (' + annotatedFiles + ') ─────────────────');
  files.filter(f => f.hasAnnotation).forEach(f =>
    console.log(`  ✅  ${f.relPath.padEnd(55)} (${f.routeCount} route)`),
  );

  console.log('\n── Annotationsız (' + (totalFiles - annotatedFiles) + ') ────────────────');
  files
    .filter(f => !f.hasAnnotation)
    .sort((a, b) => b.routeCount - a.routeCount)
    .forEach(f =>
      console.log(`  ❌  ${f.relPath.padEnd(55)} (${f.routeCount} route)`),
    );
}

console.log('\n── Öneri sırası (en yüksek route sayısı önce) ──');
const topUnannotated = files
  .filter(f => !f.hasAnnotation)
  .sort((a, b) => b.routeCount - a.routeCount)
  .slice(0, 5);

if (topUnannotated.length === 0) {
  console.log('  🎉 Tüm route dosyaları annotasyonlu!');
} else {
  topUnannotated.forEach((f, i) =>
    console.log(`  ${i + 1}. ${f.relPath} (${f.routeCount} route)`),
  );
}

console.log('');

if (CI_MODE && routeCoverage < MIN_COVERAGE_PCT) {
  console.error(`❌ Kapsam ${routeCoverage}% < eşik ${MIN_COVERAGE_PCT}% — CI başarısız`);
  // Sprint 60: CI loglarında hangi dosyaların eksik olduğunu göster
  const failList = files
    .filter(f => !f.hasAnnotation)
    .sort((a, b) => b.routeCount - a.routeCount)
    .slice(0, 10);
  if (failList.length) {
    console.error('\nAnnotasyonsuz dosyalar (route sayısına göre):');
    failList.forEach((f, i) =>
      console.error(`  ${i + 1}. ${f.relPath.padEnd(55)} (${f.routeCount} route)`),
    );
  }
  process.exit(1);
} else if (CI_MODE) {
  console.log(`✅ Kapsam ${routeCoverage}% ≥ eşik ${MIN_COVERAGE_PCT}%`);
}
