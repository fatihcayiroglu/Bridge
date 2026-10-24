#!/usr/bin/env node
//
// P7 D1: measured partition / no-partition evidence on a DISPOSABLE database.
//
// p7-partition-assessment.cjs is the read-only collector for a real
// installation. It reports catalog sizes and EXPLAIN shapes, not latency. This
// script answers the questions that collector cannot, on a named synthetic
// dataset shaped like production (see docs/P7_D1_PARTITION_DECISION.md):
//   · client-side p50/p95/p99 of the application's own hot queries;
//   · single-writer insert latency and multi-writer throughput;
//   · the two bulk deletes the product performs (channel expiry or deletion by
//     "channelId", account erasure by "userId"), with the worst concurrent write
//     while each runs;
//   · the same probes on a HASH("channelId") partitioned copy of `messages`.
//
// It WRITES. It refuses any database whose name does not start with `d1_`, and
// runs only with P7_D1_DISPOSABLE_ACK=I_UNDERSTAND. The rows it creates are
// synthetic: no personal data.
//
// Usage (the database must already carry the schema, migrated by this
// branch's code):
//   P7_D1_DISPOSABLE_ACK=I_UNDERSTAND PG_URL=postgresql://user@host/d1_bench \
//     node scripts/p7-d1-scale-benchmark.cjs populate --messages 10000000
//   ... measure --table messages --json plain.json
//   ... build-hash --partitions 16
//   ... measure --table messages_h16 --json hash16.json

'use strict';

const { Client } = require('pg');
const fs = require('fs');

const argv = process.argv.slice(2);
const phase = argv[0];
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback;
};
const num = (name, fallback) => {
  const v = Number(arg(name, fallback));
  if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`${name} must be a positive integer`);
  return v;
};
const ident = (name) => {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(name)) throw new Error(`invalid identifier: ${name}`);
  return name;
};

/** Channel of message g: 1 + floor(C · u³), a heavy-tailed (power-law) activity skew. */
const SKEW_SQL = (channels) => `1 + floor(${channels} * power(random(), 3))::int`;

async function populate(db, o) {
  const t0 = Date.now();
  const q = (sql) => db.query(sql);
  const DAY = 86_400_000;
  const start = Date.now() - o.days * DAY;
  await q('SELECT setseed(0.42)');
  await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt")
           SELECT 'd1u' || g, 'd1u' || g, 'User ' || g, 'x', 1 FROM generate_series(1, ${o.users}) g`);
  await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt")
           SELECT 'd1s' || g, 'Server ' || g, 'd1u' || g, 1 FROM generate_series(1, ${o.servers}) g`);
  // Membership: every user joins ~4 servers; a few servers are very large.
  await q(`INSERT INTO members ("userId", "serverId", "joinedAt")
           SELECT DISTINCT 'd1u' || u, 'd1s' || (1 + floor(${o.servers} * power(random(), 2))::int), (${start} + u)::bigint
           FROM generate_series(1, ${o.users}) u, generate_series(1, 4)
           ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO channels (_id, "serverId", name, "createdAt")
           SELECT 'd1c' || g, 'd1s' || (1 + (g % ${o.servers})), 'c' || g, 1 FROM generate_series(1, ${o.channels}) g`);
  // Messages arrive in time order across the window; channel by the skew above;
  // author uniform; 2 % soft-deleted, as moderation and authors do.
  await q(`INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt", "deletedAt")
           SELECT 'd1m' || g, 'd1c' || c, 'd1s' || (1 + (c % ${o.servers})), 'd1u' || (1 + floor(random() * ${o.users})::int),
                  'u', 'U', 'synthetic message ' || g || ' ' || md5(g::text),
                  (${start}::bigint + (g::bigint * ${o.days}::bigint * ${DAY}::bigint) / ${o.messages}::bigint),
                  CASE WHEN random() < 0.02 THEN 1 ELSE NULL END
           FROM (SELECT g, ${SKEW_SQL(o.channels)} AS c FROM generate_series(1, ${o.messages}) g) s`);
  await q(`INSERT INTO threads (_id, "channelId", "serverId", "createdBy", "createdAt", "lastMessageAt")
           SELECT 'd1t' || g, 'd1c' || c, 'd1s' || (1 + (c % ${o.servers})), 'd1u' || (1 + g % ${o.users}), 1, 1
           FROM (SELECT g, ${SKEW_SQL(o.channels)} AS c FROM generate_series(1, ${o.threads}) g) s`);
  await q(`INSERT INTO thread_messages (_id, "threadId", "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
           SELECT 'd1tm' || g, t._id, t."channelId", t."serverId", 'd1u' || (1 + floor(random() * ${o.users})::int), 'u', 'U',
                  'synthetic reply ' || g, (${start}::bigint + g::bigint * 1000)
           FROM (SELECT g, 'd1t' || (1 + floor(${o.threads} * power(random(), 2))::int) AS tid
                 FROM generate_series(1, ${o.threadMessages}) g) s
           JOIN threads t ON t._id = s.tid`);
  await q('VACUUM ANALYZE');
  return Date.now() - t0;
}

async function distribution(db, table) {
  const r = (await db.query(`
    WITH per AS (SELECT "channelId", count(*) AS n FROM ${table} GROUP BY 1)
    SELECT count(*)::int AS channels_with_messages, max(n)::bigint AS largest,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY n)::bigint AS p50,
           percentile_disc(0.99) WITHIN GROUP (ORDER BY n)::bigint AS p99,
           (SELECT sum(n) FROM (SELECT n FROM per ORDER BY n DESC LIMIT greatest(1, (SELECT count(*) FROM per) / 100)) top)::bigint AS top1pct_rows,
           sum(n)::bigint AS total
    FROM per`)).rows[0];
  const users = (await db.query(`SELECT max(n)::bigint AS largest, percentile_disc(0.5) WITHIN GROUP (ORDER BY n)::bigint AS p50
                                 FROM (SELECT count(*) AS n FROM ${table} GROUP BY "userId") s`)).rows[0];
  return { ...r, top1pctShare: Number(r.top1pct_rows) / Number(r.total), perUser: users };
}

function stats(samples) {
  const s = samples.slice().sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  const r = (x) => Math.round(x * 100) / 100;
  return { n: s.length, p50: r(at(0.5)), p95: r(at(0.95)), p99: r(at(0.99)), max: r(s[s.length - 1]) };
}

async function timed(db, sql, params) {
  const t0 = process.hrtime.bigint();
  const res = await db.query(sql, params);
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, rows: res.rowCount };
}

/** A random existing message: traffic is proportional to channel activity. */
async function randomMessage(db, table, total) {
  for (;;) {
    const id = 'd1m' + (1 + Math.floor(Math.random() * total));
    const row = (await db.query(`SELECT "channelId", "createdAt", _id FROM ${table} WHERE _id = $1 LIMIT 1`, [id])).rows[0];
    if (row) return row;
  }
}

/** A copy is measured only when it carries every index `messages` has (no partial builds). */
async function assertComparable(db, table) {
  if (table === 'messages') return;
  const count = async (t) => Number((await db.query(
    `SELECT count(*) AS n FROM pg_indexes WHERE tablename = $1`, [t])).rows[0].n);
  const [plain, copy] = [await count('messages'), await count(table)];
  if (copy !== plain + 1) throw new Error(`${table} has ${copy} indexes, messages has ${plain}: rebuild it before measuring (expected messages' indexes plus the _id index)`);
}

async function measure(db, table, o) {
  await assertComparable(db, table);
  const total = Number((await db.query(`SELECT max(substr(_id, 4)::bigint) AS n FROM ${table} WHERE _id LIKE 'd1m%'`)).rows[0].n);
  // The application's own shapes (MessageRepository.findByChannel and the
  // look-ahead row it requests; member and thread pagination).
  const firstPage = `SELECT * FROM ${table} WHERE "channelId" = $1 AND "deletedAt" IS NULL ORDER BY "createdAt" DESC, _id DESC LIMIT 51`;
  // findByChannel's cursor is an `$or` of (createdAt < x) and (createdAt = x AND
  // _id < y); pgCollection's keysetRowComparison sends it as this row comparison.
  const olderPage = `SELECT * FROM ${table} WHERE "channelId" = $1 AND "deletedAt" IS NULL
                       AND ("createdAt", _id) < ($2, $3) ORDER BY "createdAt" DESC, _id DESC LIMIT 51`;
  const byId = `SELECT * FROM ${table} WHERE _id = $1`;
  const out = { table, totalMessages: total, probes: {} };
  const run = async (name, make) => {
    const ms = [];
    for (let i = 0; i < 20; i++) { const [sql, p] = await make(); await db.query(sql, p); }   // warm-up
    for (let i = 0; i < o.samples; i++) { const [sql, p] = await make(); ms.push((await timed(db, sql, p)).ms); }
    out.probes[name] = stats(ms);
  };
  await run('channelFirstPage_activityWeighted', async () => [firstPage, [(await randomMessage(db, table, total)).channelId]]);
  await run('channelFirstPage_uniformChannel', async () => [firstPage, ['d1c' + (1 + Math.floor(Math.random() * o.channels))]]);
  await run('channelOlderPage_randomCursor', async () => {
    const m = await randomMessage(db, table, total);
    return [olderPage, [m.channelId, m.createdAt, m._id]];
  });
  await run('messageById', async () => [byId, ['d1m' + (1 + Math.floor(Math.random() * total))]]);
  await run('memberPage_server', async () => ['SELECT "userId" FROM members WHERE "serverId" = $1 ORDER BY "joinedAt", "userId" LIMIT 50',
    ['d1s' + (1 + Math.floor(Math.random() * o.servers))]]);
  await run('threadPage', async () => ['SELECT * FROM thread_messages WHERE "threadId" = $1 ORDER BY "createdAt" DESC LIMIT 50',
    ['d1t' + (1 + Math.floor(Math.pow(Math.random(), 2) * o.threads))]]);

  // Writes: one writer's latency, then several writers' throughput.
  const insertSql = `INSERT INTO ${table} (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
                     VALUES ($1, $2, 'd1s1', 'd1u1', 'u', 'U', $3, $4)`;
  let seq = 0;
  const nextId = () => `d1w${process.pid}-${table}-${++seq}`;
  const single = [];
  for (let i = 0; i < o.samples; i++) {
    const c = 'd1c' + (1 + Math.floor(Math.pow(Math.random(), 3) * o.channels));
    single.push((await timed(db, insertSql, [nextId(), c, 'benchmark write ' + i, Date.now()])).ms);
  }
  out.probes.insert_singleWriter = stats(single);
  const writers = o.writers;
  const until = Date.now() + o.writeSeconds * 1000;
  const lat = [];
  await Promise.all(Array.from({ length: writers }, async () => {
    const c2 = new Client({ connectionString: process.env.PG_URL });
    await c2.connect();
    while (Date.now() < until) {
      const c = 'd1c' + (1 + Math.floor(Math.pow(Math.random(), 3) * o.channels));
      lat.push((await timed(c2, insertSql, [nextId(), c, 'concurrent write', Date.now()])).ms);
    }
    await c2.end();
  }));
  out.probes[`insert_${writers}Writers`] = { ...stats(lat), perSecond: Math.round(lat.length / o.writeSeconds) };

  // Bulk deletes the product performs, each inside a rolled-back transaction so
  // every layout measures the same rows. A concurrent writer reports the worst
  // insert latency while the delete holds its locks.
  const bulk = async (name, where, params) => {
    const writer = new Client({ connectionString: process.env.PG_URL });
    await writer.connect();
    let stop = false; const wl = [];
    const loop = (async () => {
      while (!stop) {
        const c = 'd1c' + (1 + Math.floor(Math.random() * o.channels));
        wl.push((await timed(writer, insertSql, [nextId(), c, 'during bulk delete', Date.now()])).ms);
      }
    })();
    // Warm cache for both layouts: the target rows are read once first, so the
    // delete is not timed against pages a previous phase happened to load.
    await db.query(`SELECT count(*) FROM ${table} WHERE ${where}`, params);
    await db.query('BEGIN');
    let r;
    try { r = await timed(db, `DELETE FROM ${table} WHERE ${where}`, params); }
    finally { await db.query('ROLLBACK'); }
    stop = true; await loop; await writer.end();
    out.probes[name] = { ms: Math.round(r.ms), rows: r.rows, worstConcurrentInsertMs: Math.round(Math.max(...wl) * 10) / 10 };
  };
  // Measure the deletes on the dataset alone, without the write probes' rows.
  await db.query(`DELETE FROM ${table} WHERE _id LIKE 'd1w%'`);
  // The largest channel and a median one: what channel expiry / deletion deletes.
  const big = (await db.query(`SELECT "channelId", count(*) n FROM ${table} GROUP BY 1 ORDER BY n DESC LIMIT 1`)).rows[0];
  const mid = (await db.query(`SELECT "channelId", n FROM (SELECT "channelId", count(*) n FROM ${table} GROUP BY 1) s
                               ORDER BY n LIMIT 1 OFFSET (SELECT count(DISTINCT "channelId") / 2 FROM ${table})`)).rows[0];
  await bulk('deleteChannel_largest', '"channelId" = $1', [big.channelId]);
  await bulk('deleteChannel_median', '"channelId" = $1', [mid.channelId]);
  // Account erasure (lib/accountDeletion.ts: DELETE FROM messages WHERE "userId" = $1).
  await bulk('deleteUserMessages', '"userId" = $1', ['d1u' + (1 + Math.floor(o.users / 2))]);
  const plan = (await db.query(`EXPLAIN (FORMAT JSON) DELETE FROM ${table} WHERE "userId" = $1`, ['d1u1'])).rows[0]['QUERY PLAN'][0].Plan;
  const types = [];
  (function walk(n) { types.push(n['Node Type'] + (n['Index Name'] ? `(${n['Index Name']})` : '')); (n.Plans || []).forEach(walk); })(plan);
  out.probes.deleteUserMessages.plan = types;

  const size = (await db.query(`SELECT pg_total_relation_size($1::regclass) AS total, pg_indexes_size($1::regclass) AS idx`, [table])).rows[0];
  out.sizeBytes = { total: Number(size.total), indexes: Number(size.idx) };
  if (table !== 'messages') {
    // A partitioned table reports 0 for itself; sum its partitions.
    const p = (await db.query(`SELECT sum(pg_total_relation_size(inhrelid))::bigint AS total, sum(pg_indexes_size(inhrelid))::bigint AS idx
                               FROM pg_inherits WHERE inhparent = $1::regclass`, [table])).rows[0];
    out.sizeBytes = { total: Number(p.total), indexes: Number(p.idx) };
  }
  // Leave the benchmark's own writes out of later runs.
  await db.query(`DELETE FROM ${table} WHERE _id LIKE 'd1w%'`);
  return out;
}

/** A HASH("channelId") copy of `messages` with the same indexes. */
async function buildHash(db, partitions) {
  const t = ident(`messages_h${partitions}`);
  const t0 = Date.now();
  await db.query(`DROP TABLE IF EXISTS ${t}`);
  // A partitioned table's unique keys must contain the partition key: the
  // primary key becomes ("channelId", _id). Global uniqueness of _id is lost.
  await db.query(`CREATE TABLE ${t} (LIKE messages INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING CONSTRAINTS) PARTITION BY HASH ("channelId")`);
  for (let i = 0; i < partitions; i++) {
    await db.query(`CREATE TABLE ${t}_p${i} PARTITION OF ${t} FOR VALUES WITH (MODULUS ${partitions}, REMAINDER ${i})`);
  }
  await db.query(`INSERT INTO ${t} SELECT * FROM messages`);
  await db.query(`ALTER TABLE ${t} ADD PRIMARY KEY ("channelId", _id)`);
  // Lookups by _id alone (findById, reports, pins, replies) cannot use that key:
  // a partitioned design needs a separate, non-unique _id index in every partition.
  await db.query(`CREATE INDEX ${t}_id ON ${t} (_id)`);
  const idx = (await db.query(`SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'messages' AND indexname <> 'messages_pkey'`)).rows;
  const skipped = [];
  for (const { indexname, indexdef } of idx) {
    // Every copied index gets a name of its own (some messages indexes have no idx_messages prefix).
    let def = indexdef.replace(/ ON (public\.)?messages /, ` ON ${t} `).replace(/INDEX \S+ ON/, `INDEX ${ident(`${t}_${indexname}`.slice(0, 63))} ON`);
    if (/CREATE UNIQUE INDEX/.test(def)) {
      // Unique indexes must include "channelId" too: weaker than the original.
      const [head, where] = def.split(' WHERE ');
      def = head.replace(/\)$/, ', "channelId")') + (where ? ` WHERE ${where}` : '');
      skipped.push(`${indexname}: unique only per channel on the partitioned copy`);
    }
    await db.query(def);
  }
  await db.query(`ANALYZE ${t}`);
  return { table: t, partitions, buildMs: Date.now() - t0, uniquenessWeakened: skipped };
}

async function main() {
  if (process.env.P7_D1_DISPOSABLE_ACK !== 'I_UNDERSTAND') throw new Error('Set P7_D1_DISPOSABLE_ACK=I_UNDERSTAND (this script writes)');
  const url = process.env.PG_URL;
  if (!url) throw new Error('PG_URL is required');
  const db = new Client({ connectionString: url });
  await db.connect();
  const name = (await db.query('SELECT current_database() AS d')).rows[0].d;
  if (!/^d1_/.test(name)) throw new Error(`refusing to run on "${name}": the database name must start with d1_`);
  const o = {
    messages: num('--messages', 10_000_000), channels: num('--channels', 50_000), servers: num('--servers', 2_000),
    users: num('--users', 100_000), days: num('--days', 365), threads: num('--threads', 50_000),
    threadMessages: num('--thread-messages', 500_000), samples: num('--samples', 400),
    writers: num('--writers', 4), writeSeconds: num('--write-seconds', 10), partitions: num('--partitions', 16),
  };
  let result;
  if (phase === 'populate') {
    const ms = await populate(db, o);
    result = { phase, ms, options: o, distribution: await distribution(db, 'messages') };
  } else if (phase === 'build-hash') {
    result = { phase, ...(await buildHash(db, o.partitions)) };
  } else if (phase === 'measure') {
    result = { phase, postgres: (await db.query('SHOW server_version')).rows[0].server_version, options: o,
      ...(await measure(db, ident(arg('--table', 'messages')), o)) };
  } else {
    throw new Error('phase must be populate, build-hash or measure');
  }
  await db.end();
  const out = arg('--json', null);
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}

main().catch((err) => { console.error(err.message); process.exit(1); });
