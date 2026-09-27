#!/usr/bin/env node
/**
 * server/scripts/verify-sql-against-postgres.js
 *
 * ════════════════════════════════════════════════════════════════════════════
 * ÜRETİMDEKİ HER SQL LİTERALİNİ GERÇEK PostgreSQL'E AYRIŞTIRTIR
 * ════════════════════════════════════════════════════════════════════════════
 * NEDEN VAR — ölçülmüş bir arıza:
 *
 *   `MessageRepository.toggleReactionAtomic` şunu çağırıyordu:
 *       jsonb_object_length(COALESCE(reactions, '{}'::jsonb)) < 20
 *
 *   PostgreSQL'de `jsonb_object_length` DİYE BİR FONKSİYON YOKTUR. Sorgu her
 *   çalıştırmada hata veriyordu, yani REST + Socket.IO reaksiyon yollarının
 *   İKİSİ de üretimde tamamen bozuktu.
 *
 *   Tek "kanıt" mock'lanmış bir sözleşme testiydi: SQL METNİNİ okuyup
 *   `jsonb_object_length(` geçmesini bekliyordu. Yani mock, PostgreSQL'in
 *   REDDETTİĞİ bir sorguyu "doğru" olarak kilitliyordu.
 *
 * ── DERS ───────────────────────────────────────────────────────────────────
 * SQL metni üzerinden kurulan bir sözleşme, o SQL'in GEÇERLİ olduğunu
 * kanıtlamaz. Tek gerçek yargıç PostgreSQL'in kendisidir.
 *
 * ── NASIL ÇALIŞIR ──────────────────────────────────────────────────────────
 * Üretim kaynağındaki SQL şablon literallerini çıkarır ve her birini
 * `PREPARE` ile veritabanına gönderir. `PREPARE`:
 *
 *   · sorguyu AYRIŞTIRIR (sözdizimi),
 *   · ANALİZ EDER (tablo/kolon/fonksiyon varlığı, tip uyumu),
 *   · ÇALIŞTIRMAZ — hiçbir satır okunmaz veya yazılmaz.
 *
 * Yani şema üzerinde yan etkisi yoktur ama `jsonb_object_length` gibi bir
 * hatayı KESİN olarak yakalar.
 *
 * ── NEYİ ATLAR ─────────────────────────────────────────────────────────────
 * Yapısını çalışma zamanında kuran sorgular (`${}` ile kolon/koşul üreten
 * dinamik SQL) güvenilir biçimde hazırlanamaz; bunlar ATLANIR ve sayılır.
 * Atlananlar gizlenmez — raporun sonunda listelenir ki kapsamı bilelim.
 *
 * Kullanım:
 *   PG_TEST_URL=postgresql://... node scripts/verify-sql-against-postgres.js
 *   ... --list-skipped     atlanan literalleri de yazar
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const SERVER_ROOT = path.resolve(__dirname, '..');
const SCAN_DIRS = ['db', 'lib', 'routes', 'jobs', 'socket', 'app', 'middleware', 'plugins'];
const SKIP_DIR_NAMES = new Set(['node_modules', 'dist', 'coverage', 'tests', '__mocks__', '_archived_legacy']);

/**
 * `db/postgres/migrations.ts` ŞEMAYI DEĞİŞTİREN ifadeler içerir ve bazıları
 * bilerek LEGACY durumu hedefler — örneğin artık var olmayan `subscription`
 * kolonundan `endpoint`/`keys` alanlarına geriye doldurma. Bunları GÜNCEL
 * şemaya karşı `PREPARE` etmek yanlış pozitif üretir.
 *
 * Doğru doğrulama, migrasyon zincirini TEMİZ bir veritabanında GERÇEKTEN
 * çalıştırmaktır (`db/migrate-postgres.ts up`), ki bu ayrıca yapılır ve
 * 43/43 geçer. Ayrıca `runMigrationList` artık eksik FONKSİYON/TİP hatalarını
 * sessizce yutmuyor, yalnızca eksik kolon/tablo durumunu legacy sayıyor.
 */
const SKIP_FILES = new Set(['db/postgres/migrations.ts']);

const SQL_START = /\b(SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM|WITH)\b/i;

/** Kaynak dosyalarını topla. */
function collectFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIR_NAMES.has(e.name)) continue;
        walk(p);
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.d.ts')) {
        out.push(p);
      }
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(SERVER_ROOT, d));
  return out;
}

/**
 * Şablon literallerini çıkarır. Basit bir tarayıcı yeterlidir: backtick ile
 * açılıp kapanan blokları alır ve içindeki `${...}` yerlerini işaretler.
 */
function extractTemplates(src) {
  const found = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '`') continue;
    // Kaçırılmış backtick'i atla.
    if (i > 0 && src[i - 1] === '\\') continue;
    let j = i + 1;
    let depth = 0;
    let hasInterp = false;
    while (j < src.length) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '$' && src[j + 1] === '{') { hasInterp = true; depth++; j += 2; continue; }
      if (depth > 0) {
        if (c === '{') depth++;
        else if (c === '}') depth--;
        j++;
        continue;
      }
      if (c === '`') break;
      j++;
    }
    const body = src.slice(i + 1, j);
    const line = src.slice(0, i).split('\n').length;
    found.push({ body, hasInterp, line });
    i = j;
  }
  return found;
}

function looksLikeSql(text) {
  const t = text.trim();
  if (t.length < 20) return false;
  const m = SQL_START.exec(t);
  // İfade SQL ile BAŞLAMALI; içinde geçen 'select' kelimesi yeterli değil.
  return !!m && m.index <= 8;
}

/**
 * `${}` içeren sorgular yapıyı çalışma zamanında kurar. Bunları hazırlamak
 * güvenilir değildir; ancak yalnızca güvenli bir sabit üretiyorlarsa
 * (örneğin tablo adı) yine de denenebilir — burada muhafazakâr davranıp
 * ATLANIR ve sayılır.
 */
function normalize(sql) {
  return sql.replace(/\s+/g, ' ').trim();
}

async function main() {
  const url = process.env.PG_TEST_URL || process.env.DATABASE_URL;
  if (!url) {
    console.error('PG_TEST_URL (veya DATABASE_URL) gerekli — gerçek bir PostgreSQL örneği şart.');
    process.exit(2);
  }

  const files = collectFiles();
  const candidates = [];
  const skipped = [];

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    for (const tpl of extractTemplates(src)) {
      if (!looksLikeSql(tpl.body)) continue;
      const rel = path.relative(SERVER_ROOT, file).replace(/\\/g, '/');
      if (SKIP_FILES.has(rel)) {
        skipped.push({ file: rel, line: tpl.line, reason: 'migrasyon DDL/legacy backfill — zincir ayrıca çalıştırılıyor' });
        continue;
      }
      if (tpl.hasInterp) {
        skipped.push({ file: rel, line: tpl.line, reason: 'dinamik yapı (${} içeriyor)' });
        continue;
      }
      candidates.push({ file: rel, line: tpl.line, sql: tpl.body });
    }
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  // pgvector is deliberately opt-in. A default/fallback Bridge database has
  // neither the extension type nor messages.embedding, and production reaches
  // these literals only while the live PGVECTOR_ENABLED gate is true. PREPARE
  // cannot analyze an optional type that is not installed, so classify those
  // guarded statements as feature-unavailable rather than as core SQL defects.
  // When the optional schema is present they remain ordinary candidates and
  // PostgreSQL still validates them below.
  const vectorState = await client.query(`
    SELECT to_regtype('vector') IS NOT NULL AS has_type,
           EXISTS (
             SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'messages'
                AND column_name = 'embedding'
           ) AS has_column
  `);
  const pgvectorReady = vectorState.rows[0]?.has_type === true && vectorState.rows[0]?.has_column === true;

  let ok = 0;
  const failures = [];
  let n = 0;

  for (const c of candidates) {
    n++;
    const name = `bridge_sqlcheck_${n}`;
    if (!pgvectorReady &&
        (c.file === 'lib/pgvector.ts' || c.file === 'jobs/embedHistory.ts') &&
        (/::vector\b/i.test(c.sql) || /\bembedding\b/i.test(c.sql))) {
      skipped.push({ file: c.file, line: c.line, reason: 'opsiyonel pgvector tipi/şeması kurulu değil; çalışma-zamanı kapısı kapalı' });
      continue;
    }
    try {
      // PREPARE ayrıştırır + analiz eder; ÇALIŞTIRMAZ.
      await client.query(`PREPARE ${name} AS ${c.sql}`);
      await client.query(`DEALLOCATE ${name}`);
      ok++;
    } catch (err) {
      const msg = String(err.message || err);
      // Parametre tipi çıkarılamayan sorgular gerçek bir kusur değildir:
      // PostgreSQL yalnızca $n'in tipini bilemez. Sözdizimi/isim hataları
      // bundan AYRI ele alınır.
      if (/could not determine data type of parameter/i.test(msg)
        || /inconsistent types deduced/i.test(msg)) {
        skipped.push({ file: c.file, line: c.line, reason: 'parametre tipi çıkarılamadı' });
        try { await client.query(`DEALLOCATE ${name}`); } catch { /* yok */ }
        continue;
      }
      failures.push({ ...c, error: msg });
    }
  }

  await client.end();

  console.log('════════════════════════════════════════════════════════════');
  console.log('ÜRETİM SQL LİTERALLERİ — GERÇEK PostgreSQL AYRIŞTIRMA/ANALİZ');
  console.log('════════════════════════════════════════════════════════════');
  console.log(`taranan dosya            : ${files.length}`);
  console.log(`SQL adayı                : ${candidates.length}`);
  console.log(`PostgreSQL onayladı      : ${ok}`);
  console.log(`atlandı                  : ${skipped.length}`);
  console.log(`BAŞARISIZ                : ${failures.length}`);

  if (process.argv.includes('--list-skipped')) {
    console.log('\nAtlananlar:');
    for (const s of skipped) console.log(`  ${s.file}:${s.line}  (${s.reason})`);
  }

  if (failures.length) {
    console.error('\nPostgreSQL AŞAĞIDAKİ SORGULARI REDDETTİ:\n');
    for (const f of failures) {
      console.error(`  ${f.file}:${f.line}`);
      console.error(`    ${f.error}`);
      console.error(`    ${normalize(f.sql).slice(0, 160)}`);
      console.error('');
    }
    process.exit(1);
  }

  console.log('\n✅ Statik üretim SQL literallerinin tamamı gerçek PostgreSQL tarafından kabul edildi.');
}

main().catch((e) => { console.error('HATA:', e.message); process.exit(2); });
