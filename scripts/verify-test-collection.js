#!/usr/bin/env node
/**
 * scripts/verify-test-collection.js
 *
 * ════════════════════════════════════════════════════════════════════════════
 * BİR KAPI, ÇALIŞAMADIĞINDA GEÇMİŞ GİBİ GÖRÜNÜR
 * ════════════════════════════════════════════════════════════════════════════
 * 2026-08-28 incelemesinde ölçülen gerçek arıza: kök/sunucu `overrides`
 * `glob: 13.0.6` sabitliyordu; `test-exclude@6` ise `promisify(require('glob'))`
 * çağırıyor ve glob 13'ün nesne ihracatında bu FIRLATIYOR. Sonuç:
 *
 *     jest --coverage  →  254 / 277 süit "failed to run"
 *                         4333 testten yalnızca 618'i toplandı
 *
 * Düz `jest` çalıştığı için hata AYLARCA görünmedi; yalnızca `--coverage`
 * kırıktı. `server/package.json` içindeki ~45 `coverageThreshold` girdisi bu
 * yüzden hiçbir zaman UYGULANABİLİR değildi ve depodaki tüm geçmiş kapsam
 * çıktıları güvenilmezdi. Bu boşlukta İKİ P0 çalışma zamanı kusuru saklandı.
 *
 * ── BU BETİK NE YAPAR ──────────────────────────────────────────────────────
 * "Yeşil" olmayı yeterli saymaz; koşunun GERÇEKTEN ne kadarını ölçtüğünü
 * doğrular:
 *
 *   1. Diskteki test dosyası sayısını sayar (jest'in `testMatch` deseniyle).
 *   2. Jest'in JSON sonucundaki YÜRÜTÜLEN süit sayısıyla karşılaştırır.
 *   3. Kapsam özetinde ölçülen ÜRETİM dosyası sayısını denetler.
 *   4. Toplam kapsamın makul (sıfır olmayan) olduğunu denetler.
 *
 * ── TOLERANSLAR NEDEN ORANSAL ─────────────────────────────────────────────
 * Sabit sayı yazmak (örn. "277 süit olmalı") her yeni test dosyasında CI'yı
 * kırardı ve insanlar sayıyı güncellemeyi öğrenirdi — yani kapı yine ölürdü.
 * Bunun yerine eşikler diskten TÜRETİLİR ve yalnızca büyük sapmalarda düşer:
 * amaç "birkaç süit eksik" değil, "ölçüm çöktü" durumunu yakalamaktır.
 *
 * Kullanım:
 *   node scripts/verify-test-collection.js \
 *     --results server/jest-results.json \
 *     --coverage server/coverage/coverage-summary.json \
 *     --test-dir server/tests --test-glob '.test.ts'
 */
'use strict';

const fs = require('fs');
const path = require('path');

// ── Argümanlar ──────────────────────────────────────────────────────────────
function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const resultsPath = arg('results');
const coveragePath = arg('coverage');
const testDir = arg('test-dir');
const testSuffix = arg('test-glob', '.test.ts');

/**
 * Yürütülen süitlerin, diskte bulunanların en az bu oranı olması beklenir.
 * 0.95 seçildi: birkaç dosyanın `testPathIgnorePatterns` ile dışlanması
 * normaldir, ama %5'ten fazlasının kaybolması bir toplama arızasıdır.
 */
const MIN_SUITE_RATIO = Number(arg('min-suite-ratio', '0.95'));

/**
 * Kapsam raporunda ölçülen üretim dosyası alt sınırı. `collectCoverageFrom`
 * onlarca dosya kapsar; rapor tek haneli dosya içeriyorsa enstrümantasyon
 * çökmüş demektir.
 */
const MIN_COVERED_FILES = Number(arg('min-covered-files', '50'));

/** Toplam ifade kapsamı bu değerin altındaysa ölçüm anlamlı değildir. */
const MIN_STATEMENTS_PCT = Number(arg('min-statements-pct', '25'));

const problems = [];
const notes = [];

function fail(msg) { problems.push(msg); }
function note(msg) { notes.push(msg); }

// ── 1. Diskteki test dosyaları ─────────────────────────────────────────────
function countTestFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '__mocks__') continue;
        walk(p);
      } else if (e.name.endsWith(testSuffix)) {
        n++;
      }
    }
  };
  walk(dir);
  return n;
}

// ── 2. Jest sonucu ─────────────────────────────────────────────────────────
function readJson(p, label) {
  if (!p) { fail(`${label} yolu verilmedi.`); return null; }
  if (!fs.existsSync(p)) { fail(`${label} bulunamadı: ${p}`); return null; }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { fail(`${label} ayrıştırılamadı (${p}): ${e.message}`); return null; }
}

function main() {
  console.log('── Test toplama doğrulaması ──────────────────────────────────');

  const onDisk = testDir ? countTestFiles(testDir) : null;
  if (onDisk !== null) console.log(`diskteki test dosyası      : ${onDisk}`);

  const results = readJson(resultsPath, 'Jest sonuç dosyası');
  if (results) {
    const executed = Number(results.numTotalTestSuites || 0);
    const failedSuites = Number(results.numFailedTestSuites || 0);
    const totalTests = Number(results.numTotalTests || 0);
    const failedTests = Number(results.numFailedTests || 0);

    console.log(`yürütülen süit             : ${executed} (başarısız: ${failedSuites})`);
    console.log(`yürütülen test             : ${totalTests} (başarısız: ${failedTests})`);

    if (executed === 0) fail('Hiç test süiti yürütülmedi.');
    if (totalTests === 0) fail('Hiç test yürütülmedi.');
    if (failedSuites > 0) fail(`${failedSuites} süit başarısız.`);
    if (failedTests > 0) fail(`${failedTests} test başarısız.`);

    // ASIL KORUMA: "failed to run" süitleri Jest yine de sayar, bu yüzden
    // sayı tek başına yetmez — başarısız süit sayısı da sıfır olmalıdır
    // (yukarıda). Buradaki oran, süitlerin TOPLANMADIĞI durumu yakalar.
    if (onDisk !== null && onDisk > 0) {
      const ratio = executed / onDisk;
      console.log(`toplama oranı              : ${(ratio * 100).toFixed(1)}%`);
      if (ratio < MIN_SUITE_RATIO) {
        fail(`Diskte ${onDisk} test dosyası var ama yalnızca ${executed} süit yürütüldü `
           + `(${(ratio * 100).toFixed(1)}% < ${(MIN_SUITE_RATIO * 100).toFixed(0)}%). `
           + 'Test toplama arızası olabilir.');
      }
    }
  }

  // ── 3. Kapsam özeti ──────────────────────────────────────────────────────
  if (coveragePath) {
    const cov = readJson(coveragePath, 'Kapsam özeti');
    if (cov) {
      const files = Object.keys(cov).filter(k => k !== 'total');
      const pct = cov.total && cov.total.statements ? cov.total.statements.pct : 0;
      console.log(`kapsanan dosya             : ${files.length}`);
      console.log(`toplam ifade kapsamı       : ${pct}%`);

      if (files.length < MIN_COVERED_FILES) {
        fail(`Kapsam raporunda yalnızca ${files.length} dosya var (alt sınır ${MIN_COVERED_FILES}). `
           + 'Enstrümantasyon çökmüş olabilir.');
      }
      if (!(pct >= MIN_STATEMENTS_PCT)) {
        fail(`Toplam ifade kapsamı ${pct}% — alt sınır ${MIN_STATEMENTS_PCT}%. `
           + 'Ölçüm anlamlı değil.');
      }

      // Tamamen sıfır kapsamlı dosyalar tek başına hata değildir (ölü kod
      // olabilir), ama HEPSİ sıfırsa enstrümantasyon çalışmamıştır.
      const allZero = files.length > 0 && files.every(f => cov[f].statements.pct === 0);
      if (allZero) fail('Kapsanan tüm dosyalar %0 — enstrümantasyon çalışmamış.');

      const zero = files.filter(f => cov[f].statements.pct === 0).length;
      if (zero) note(`${zero} dosya %0 kapsamlı (ölü kod veya test edilmemiş olabilir).`);
    }
  }

  console.log('──────────────────────────────────────────────────────────────');
  for (const n of notes) console.log(`NOT : ${n}`);

  if (problems.length) {
    console.error('');
    console.error('TEST TOPLAMA DOĞRULAMASI BAŞARISIZ:');
    for (const p of problems) console.error(`  ✗ ${p}`);
    console.error('');
    console.error('Bu kapı, "yeşil ama hiçbir şey ölçmeyen" bir koşuyu yakalamak için var.');
    process.exit(1);
  }

  console.log('✅ Test toplama doğrulaması geçti.');
}

main();
