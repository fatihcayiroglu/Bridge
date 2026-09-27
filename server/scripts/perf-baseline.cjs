#!/usr/bin/env node
/**
 * server/scripts/perf-baseline.cjs
 *
 * ════════════════════════════════════════════════════════════════════════════
 * TEKRARLANABİLİR PERFORMANS TABANI — PAZARLAMA KIYASLAMASI DEĞİL
 * ════════════════════════════════════════════════════════════════════════════
 * Faz 1 incelemesinde performans 5/10 puanlandı, gerekçe basitti: HİÇBİR ŞEY
 * ÖLÇÜLMEMİŞTİ. Bu betik o boşluğu kapatır ve mühendislik açısından anlamlı
 * birkaç temel değeri ölçer:
 *
 *   1. BÜYÜK bir kanalda mesaj sayfalama (en yeni sayfa + geriye sayfalama)
 *   2. Kanal listesi için son-mesaj zaman damgası toplaması (N+1 riski)
 *   3. Sorgu PLANLARI — Seq Scan / eksik indeks tespiti
 *
 * ── NEDEN BU ÜÇÜ ──────────────────────────────────────────────────────────
 * Hepsi KULLANICI YOLUNDA ve veri büyüdükçe bozulur. Mikro-optimizasyon
 * hedefi değildir; amaç "100k mesajlı bir kanal açılır mı" sorusuna ÖLÇÜMLE
 * cevap vermek ve indeks gerilemesini yakalamaktır.
 *
 * ── DÜRÜSTLÜK NOTU ────────────────────────────────────────────────────────
 * Ölçüm tek bir yerel makinede, tek bir PostgreSQL örneğinde yapılır. Bu
 * SUNUCU KAPASİTESİ DEĞİL, SORGU DAVRANIŞI hakkında bilgi verir. Ağ, eşzamanlı
 * kullanıcı, disk baskısı ve çok-node etkileri KAPSAM DIŞIDIR.
 *
 * Kullanım:
 *   PG_TEST_URL=postgresql://... node scripts/perf-baseline.cjs [--messages 100000]
 */
'use strict';

const { Client } = require('pg');
const crypto = require('crypto');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const TOTAL_MESSAGES = Number(arg('messages', '300000'));
const ITERATIONS = Number(arg('iterations', '30'));
const PAGE_SIZE = Number(arg('page', '50'));
/**
 * Hedef kanaldaki mesaj sayısı. TABLO BOYUTUNDAN ÇOK DAHA KÜÇÜK olmalıdır.
 *
 * İlk sürümde mesajların %90'ı tek bir kanala yazılıyordu ve sonuçlar
 * YANILTICIYDI: PostgreSQL `createdAt` indeksini geriye tarayıp ilk 50 eşleşmeyi
 * anında buluyordu (çünkü neredeyse her satır eşleşiyordu). Üretimde bir kanal
 * global `messages` tablosunun küçük bir yüzdesidir; o rejimde aynı sorgu
 * tamamen farklı davranır. Ölçüm bu yüzden gerçekçi seçicilikle yapılır.
 */
const TARGET_CHANNEL_MESSAGES = Number(arg('target-channel', '30000'));
const OTHER_CHANNELS = Number(arg('other-channels', '200'));

const uid = () => crypto.randomUUID();

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function stats(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: percentile(s, 50),
    p95: percentile(s, 95),
    p99: percentile(s, 99),
    max: s[s.length - 1] ?? 0,
  };
}

function fmt(ms) { return `${ms.toFixed(2)} ms`; }

async function measure(label, iterations, fn) {
  // Isınma: ilk çağrı plan/önbellek maliyeti taşır ve tabloyu çarpıtır.
  await fn();
  const samples = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    await fn(i);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const s = stats(samples);
  console.log(`  ${label.padEnd(46)} p50 ${fmt(s.p50).padStart(10)}  p95 ${fmt(s.p95).padStart(10)}  p99 ${fmt(s.p99).padStart(10)}`);
  return s;
}

async function main() {
  const url = process.env.PG_TEST_URL || process.env.DATABASE_URL;
  if (!url) { console.error('PG_TEST_URL gerekli.'); process.exit(2); }

  const client = new Client({ connectionString: url });
  await client.connect();

  const ownerId = uid();
  const serverId = uid();
  const channelId = uid();
  const otherChannels = Array.from({ length: OTHER_CHANNELS }, () => uid());
  const now = Date.now();

  console.log('════════════════════════════════════════════════════════════');
  console.log('BRIDGE PERFORMANS TABANI');
  console.log('════════════════════════════════════════════════════════════');
  const version = (await client.query('SELECT version()')).rows[0].version;
  console.log(version.split(',')[0]);
  console.log(`mesaj sayısı : ${TOTAL_MESSAGES.toLocaleString('tr')}`);
  console.log(`hedef kanal  : ${TARGET_CHANNEL_MESSAGES.toLocaleString('tr')} (tablonun %${((TARGET_CHANNEL_MESSAGES / TOTAL_MESSAGES) * 100).toFixed(1)}'i)`);
  console.log(`diğer kanal  : ${OTHER_CHANNELS}`);
  console.log(`sayfa boyutu : ${PAGE_SIZE}`);
  console.log(`yineleme     : ${ITERATIONS}`);
  console.log('');

  try {
    // ── Tohumlama ──────────────────────────────────────────────────────────
    console.log('Tohumlanıyor…');
    const seedStart = Date.now();
    await client.query(
      'INSERT INTO users (_id, username, "displayName", password, "tokenVersion", "createdAt")'
      + ' VALUES ($1,$2,$3,$4,0,$5)', [ownerId, 'perf_' + ownerId.slice(0, 8), 'Perf', 'x', now]);
    await client.query('INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1,$2,$3,$4)',
      [serverId, 'Perf Server', ownerId, now]);
    for (const ch of [channelId, ...otherChannels]) {
      await client.query('INSERT INTO channels (_id, "serverId", name, type, "createdAt") VALUES ($1,$2,$3,$4,$5)',
        [ch, serverId, 'perf', 'text', now]);
    }

    // ── TOHUMLAMA TAMAMEN SQL İÇİNDE ────────────────────────────────────
    // Satır satır INSERT 300k kayıt için dakikalar sürerdi; `COPY` ise ek bir
    // bağımlılık gerektirirdi. `generate_series` ikisini de gereksiz kılar.
    //
    // GERÇEKÇİ SEÇİCİLİK: hedef kanal tablonun küçük bir yüzdesidir. Aksi hâlde
    // PostgreSQL `createdAt` indeksini geriye tarayarak ilk 50 eşleşmeyi anında
    // bulur ve sayfalama OLDUĞUNDAN HIZLI görünür.
    await client.query(
      `INSERT INTO messages
         (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
       SELECT gen_random_uuid()::text, $1, $2, $3, 'perf', 'Perf',
              'mesaj ' || i, $4::bigint - ((($5::bigint - i) * 977)::bigint)
         FROM generate_series(1, $5::int) AS i`,
      [channelId, serverId, ownerId, now, TARGET_CHANNEL_MESSAGES],
    );
    // Arka plan: diğer kanallara dağılmış mesajlar (başka sunucu/kanal trafiği).
    const background = Math.max(0, TOTAL_MESSAGES - TARGET_CHANNEL_MESSAGES);
    if (background > 0) {
      await client.query(
        `INSERT INTO messages
           (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
         SELECT gen_random_uuid()::text,
                ($1::text[])[(i % array_length($1::text[], 1)) + 1],
                $2, $3, 'perf', 'Perf', 'arka plan ' || i,
                $4::bigint - ((($5::bigint - i) * 331)::bigint)
           FROM generate_series(1, $5::int) AS i`,
        [otherChannels, serverId, ownerId, now, background],
      );
    }
    await client.query('ANALYZE messages');
    console.log(`  tohumlama: ${((Date.now() - seedStart) / 1000).toFixed(1)} s\n`);

    const { rows: cnt } = await client.query(
      'SELECT count(*)::int AS n FROM messages WHERE "channelId" = $1', [channelId]);
    console.log(`hedef kanaldaki mesaj: ${cnt[0].n.toLocaleString('tr')}\n`);

    // ── Ölçümler ───────────────────────────────────────────────────────────
    console.log('MESAJ SAYFALAMA');
    const newest = await measure('en yeni sayfa (ilk açılış)', ITERATIONS, () =>
      client.query(
        'SELECT * FROM messages WHERE "channelId" = $1 ORDER BY "createdAt" DESC LIMIT $2',
        [channelId, PAGE_SIZE]));

    // Geriye sayfalama için gerçek bir cursor al.
    const { rows: firstPage } = await client.query(
      'SELECT "createdAt" FROM messages WHERE "channelId" = $1 ORDER BY "createdAt" DESC LIMIT $2',
      [channelId, PAGE_SIZE]);
    const cursor = Number(firstPage[firstPage.length - 1].createdAt);

    const backward = await measure('geriye sayfalama (cursor)', ITERATIONS, () =>
      client.query(
        'SELECT * FROM messages WHERE "channelId" = $1 AND "createdAt" < $2 ORDER BY "createdAt" DESC LIMIT $3',
        [channelId, cursor, PAGE_SIZE]));

    const deep = await measure('DERİN sayfalama (en eskiye yakın)', ITERATIONS, () =>
      client.query(
        'SELECT * FROM messages WHERE "channelId" = $1 AND "createdAt" < $2 ORDER BY "createdAt" DESC LIMIT $3',
        [channelId, now - TOTAL_MESSAGES * 1000 + 5000, PAGE_SIZE]));

    console.log('\nKANAL LİSTESİ');
    // Bir SUNUCUNUN kanalları kadar (tüm tablo değil) — sidebar bunu yapar.
    const sidebarChannels = [channelId, ...otherChannels.slice(0, 20)];
    const lastTs = await measure(`${sidebarChannels.length} kanal için son mesaj zamanı`, ITERATIONS, () =>
      client.query(
        'SELECT "channelId", MAX("createdAt") AS "lastAt" FROM messages WHERE "channelId" = ANY($1) GROUP BY "channelId"',
        [sidebarChannels]));

    // ── ALTERNATİF FORMÜLASYON: LATERAL ─────────────────────────────────
    // `MAX() GROUP BY` her kanalın TÜM satırlarını tarar. "Grup başına en
    // büyük" için kanonik hızlı biçim, kanal başına indeksten TEK satır
    // çekmektir. Öneri tahmine değil ÖLÇÜME dayansın diye ikisi de ölçülür.
    const lateral = await measure('  ↳ aynı sonuç, LATERAL ile', ITERATIONS, () =>
      client.query(
        `SELECT c.id AS "channelId", m."createdAt" AS "lastAt"
           FROM unnest($1::text[]) AS c(id)
           LEFT JOIN LATERAL (
             SELECT "createdAt" FROM messages
              WHERE "channelId" = c.id
              ORDER BY "createdAt" DESC
              LIMIT 1
           ) m ON TRUE`,
        [sidebarChannels]));

    console.log('\nARAMA');
    const fts = await measure('kanal içi arama (ILIKE)', Math.min(ITERATIONS, 10), () =>
      client.query(
        `SELECT _id FROM messages WHERE "channelId" = $1 AND content ILIKE $2 ORDER BY "createdAt" DESC LIMIT 25`,
        [channelId, '%mesaj 99%']));

    // ── Planlar ────────────────────────────────────────────────────────────
    console.log('\nSORGU PLANLARI (Seq Scan = eksik/kullanılmayan indeks)');
    const plans = [
      ['en yeni sayfa', 'SELECT * FROM messages WHERE "channelId" = $1 ORDER BY "createdAt" DESC LIMIT 50', [channelId]],
      ['geriye sayfalama', 'SELECT * FROM messages WHERE "channelId" = $1 AND "createdAt" < $2 ORDER BY "createdAt" DESC LIMIT 50', [channelId, cursor]],
      ['son mesaj toplaması', 'SELECT "channelId", MAX("createdAt") FROM messages WHERE "channelId" = ANY($1) GROUP BY "channelId"', [sidebarChannels]],
      ['son mesaj (LATERAL)', 'SELECT c.id, m."createdAt" FROM unnest($1::text[]) AS c(id) LEFT JOIN LATERAL (SELECT "createdAt" FROM messages WHERE "channelId" = c.id ORDER BY "createdAt" DESC LIMIT 1) m ON TRUE', [sidebarChannels]],
    ];
    const warnings = [];
    for (const [label, sql, params] of plans) {
      const { rows } = await client.query(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`, params);
      const plan = rows[0]['QUERY PLAN'][0];
      const text = JSON.stringify(plan);
      const seq = /"Node Type":"Seq Scan"/.test(text);
      const exec = plan['Execution Time'];
      console.log(`  ${label.padEnd(46)} ${exec.toFixed(2)} ms   ${seq ? 'SEQ SCAN ⚠' : 'index'}`);
      if (seq) warnings.push(`${label}: Seq Scan`);
    }

    console.log('\n────────────────────────────────────────────────────────────');
    if (warnings.length) {
      console.log('UYARILAR:');
      for (const w of warnings) console.log(`  ⚠ ${w}`);
    } else {
      console.log('✅ Ölçülen hot-path sorgularının hiçbiri Seq Scan kullanmıyor.');
    }

    // Makine bağlamı — sayılar bağlamsız okunmasın.
    const mem = process.memoryUsage();
    console.log(`\nsüreç RSS: ${(mem.rss / 1024 / 1024).toFixed(0)} MB   heap: ${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB`);

    console.log('\nJSON:');
    console.log(JSON.stringify({
      messages: TOTAL_MESSAGES, pageSize: PAGE_SIZE, iterations: ITERATIONS,
      newestPage: newest, backwardPage: backward, deepPage: deep,
      lastTimestamps: lastTs, lastTimestampsLateral: lateral, search: fts, seqScanWarnings: warnings,
    }, null, 2));
  } finally {
    // Tohumlanan her şeyi temizle (cascade).
    console.log('\nTemizleniyor…');
    await client.query('DELETE FROM messages WHERE "serverId" = $1', [serverId]).catch(() => {});
    await client.query('DELETE FROM channels WHERE "serverId" = $1', [serverId]).catch(() => {});
    await client.query('DELETE FROM servers WHERE _id = $1', [serverId]).catch(() => {});
    await client.query('DELETE FROM users WHERE _id = $1', [ownerId]).catch(() => {});
    await client.end();
  }
}

main().catch((e) => { console.error('HATA:', e.message); process.exit(1); });
