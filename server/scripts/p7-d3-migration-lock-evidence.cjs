#!/usr/bin/env node
//
// P7 D3: measured lock and runtime evidence for pending migrations, applied the
// way production applies them (db/postgres/versionedMigrations.ts
// applyPendingMigrations: one transaction per file, recorded in
// schema_migrations), against a populated database while a writer runs.
//
// For each migration it reports:
//   · wall time of the migration transaction;
//   · every relation lock the migration still holds just before COMMIT (these
//     are held for the whole transaction), with the lock mode and whether that
//     mode blocks ordinary INSERT/UPDATE/DELETE (ROW EXCLUSIVE) or SELECT;
//   · the slowest concurrent write while the migration ran: a separate
//     connection keeps inserting into `messages` and `message_reports`, so a
//     lock that blocks writers shows up as measured latency, not as a guess.
//
// It only applies migrations that are pending in the target database and
// never rolls anything back: point it at a disposable copy, never production.
//
// Usage:
//   PG_URL=postgresql://user@host:port/disposable_db \
//   node scripts/p7-d3-migration-lock-evidence.cjs [--populate] [--json out.json]
//     [--messages 2000000] [--reports 200000] [--channels 50000]
//
// --populate seeds a database that is at the pre-migration schema with
// synthetic rows (no personal data) before measuring. Sizes are configurable.

'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations_pg');
// Modes that conflict with ROW EXCLUSIVE (what INSERT/UPDATE/DELETE take) and
// with ACCESS SHARE (what SELECT takes).
const BLOCKS_WRITES = new Set(['ShareLock', 'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock']);
const BLOCKS_READS = new Set(['AccessExclusiveLock']);

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = name => process.argv.includes(name);

async function populate(db, sizes) {
  const started = Date.now();
  const q = sql => db.query(sql);
  await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt")
           SELECT 'd3u' || g, 'd3u' || g, 'D3 user ' || g, 'x', 1 FROM generate_series(1, 10000) g
           ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt")
           SELECT 'd3s' || g, 'D3 server ' || g, 'd3u' || g, 1 FROM generate_series(1, 100) g
           ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO members ("userId", "serverId", "joinedAt")
           SELECT 'd3u' || g, 'd3s' || (1 + g % 100), 1 FROM generate_series(1, 10000) g
           ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO channels (_id, "serverId", name, "createdAt")
           SELECT 'd3c' || g, 'd3s' || (1 + g % 100), 'c' || g, 1 FROM generate_series(1, ${sizes.channels}) g
           ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
           SELECT 'd3m' || g, 'd3c' || (1 + g % ${sizes.channels}), 'd3s' || (1 + (1 + g % ${sizes.channels}) % 100),
                  'd3u' || (1 + g % 10000), 'u', 'U', 'synthetic message ' || g, g
           FROM generate_series(1, ${sizes.messages}) g
           ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO message_reports (_id, "serverId", "channelId", "messageId", "reporterId", reason, "createdAt")
           SELECT 'd3r' || g, 'd3s' || (1 + (1 + g % ${sizes.channels}) % 100), 'd3c' || (1 + g % ${sizes.channels}),
                  'd3m' || g, 'd3u' || (1 + g % 10000), 'spam', g
           FROM generate_series(1, ${sizes.reports}) g
           ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO threads (_id, "channelId", "serverId", "createdBy", "createdAt", "lastMessageAt")
           SELECT 'd3t' || g, 'd3c' || (1 + g % ${sizes.channels}), 'd3s' || (1 + (1 + g % ${sizes.channels}) % 100),
                  'd3u' || (1 + g % 10000), 1, 1
           FROM generate_series(1, ${sizes.threads}) g
           ON CONFLICT DO NOTHING`);
  await q(`INSERT INTO thread_messages (_id, "threadId", "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
           SELECT 'd3tm' || g, 'd3t' || (1 + g % ${sizes.threads}), 'd3c' || (1 + (1 + g % ${sizes.threads}) % ${sizes.channels}),
                  'd3s' || (1 + (1 + (1 + g % ${sizes.threads}) % ${sizes.channels}) % 100),
                  'd3u' || (1 + g % 10000), 'u', 'U', 'synthetic reply ' || g, g
           FROM generate_series(1, ${sizes.threadMessages}) g
           ON CONFLICT DO NOTHING`);
  await q('ANALYZE');
  return Date.now() - started;
}

async function counts(db) {
  const out = {};
  for (const table of ['messages', 'message_reports', 'channels', 'threads', 'thread_messages', 'users', 'servers']) {
    out[table] = Number((await db.query(`SELECT count(*)::bigint AS n FROM ${table}`)).rows[0].n);
  }
  return out;
}

/** Inserts into messages and message_reports until stopped; returns per-write samples. */
function startWriter(url) {
  const samples = [];
  let stop = false;
  const done = (async () => {
    const db = new Client({ connectionString: url });
    await db.connect();
    await db.query("SET application_name = 'd3-writer'");
    let n = 0;
    while (!stop) {
      n += 1;
      const at = Date.now();
      const t0 = process.hrtime.bigint();
      // A live permanent channel; message_reports references the new message.
      await db.query(`INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
                      VALUES ($1, 'd3c1', 'd3s2', 'd3u1', 'u', 'U', 'concurrent write', $2)`, [`d3w${process.pid}-${n}`, at]);
      await db.query(`INSERT INTO message_reports (_id, "serverId", "channelId", "messageId", "reporterId", reason, "createdAt")
                      VALUES ($1, 'd3s2', 'd3c1', $2, 'd3u2', 'spam', $3)`, [`d3wr${process.pid}-${n}`, `d3w${process.pid}-${n}`, at]);
      samples.push({ at, ms: Number(process.hrtime.bigint() - t0) / 1e6 });
      await new Promise(r => setTimeout(r, 5));
    }
    await db.end();
  })();
  return { samples, stop: async () => { stop = true; await done; } };
}

async function applyOne(db, file) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
  const started = Date.now();
  const t0 = process.hrtime.bigint();
  await db.query('BEGIN');
  let locks;
  try {
    await db.query(sql);
    locks = (await db.query(`
      SELECT c.relname AS relation, l.mode
        FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE l.pid = pg_backend_pid() AND l.granted AND l.locktype = 'relation'
         AND n.nspname = 'public' AND c.relkind IN ('r', 'p')
       ORDER BY 1, 2`)).rows;
    await db.query(
      'INSERT INTO schema_migrations (id, applied_at, rolled_back) VALUES ($1, $2, FALSE) ' +
      'ON CONFLICT (id) DO UPDATE SET rolled_back = FALSE, applied_at = $2', [file, Date.now()]);
    await db.query('COMMIT');
  } catch (err) {
    await db.query('ROLLBACK').catch(() => undefined);
    throw new Error(`${file}: ${err.message}`, { cause: err });
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  // Strongest mode per table.
  const order = ['AccessShareLock', 'RowShareLock', 'RowExclusiveLock', 'ShareUpdateExclusiveLock', 'ShareLock',
    'ShareRowExclusiveLock', 'ExclusiveLock', 'AccessExclusiveLock'];
  const strongest = new Map();
  for (const { relation, mode } of locks) {
    if (!strongest.has(relation) || order.indexOf(mode) > order.indexOf(strongest.get(relation))) strongest.set(relation, mode);
  }
  return {
    file, started, ended: started + ms, ms,
    locks: [...strongest].map(([relation, mode]) => ({
      relation, mode, blocksWrites: BLOCKS_WRITES.has(mode), blocksReads: BLOCKS_READS.has(mode),
    })),
  };
}

async function main() {
  const url = process.env.PG_URL;
  if (!url) throw new Error('PG_URL is required (a disposable database)');
  const sizes = {
    messages: Number(arg('--messages', 2_000_000)),
    reports: Number(arg('--reports', 200_000)),
    channels: Number(arg('--channels', 50_000)),
    threads: Number(arg('--threads', 20_000)),
    threadMessages: Number(arg('--thread-messages', 200_000)),
  };
  const db = new Client({ connectionString: url });
  await db.connect();
  const populateMs = flag('--populate') ? await populate(db, sizes) : null;
  const rows = await counts(db);
  const applied = new Set((await db.query('SELECT id FROM schema_migrations WHERE rolled_back = FALSE')).rows.map(r => r.id));
  const pending = fs.readdirSync(MIGRATIONS_DIR).filter(f => /^\d{3}_.+\.sql$/.test(f)).sort().filter(f => !applied.has(f));
  const version = (await db.query('SHOW server_version')).rows[0].server_version;

  const writer = startWriter(url);
  await new Promise(r => setTimeout(r, 1000));              // baseline before the first migration
  const results = [];
  for (const file of pending) {
    results.push(await applyOne(db, file));
    await new Promise(r => setTimeout(r, 300));             // let the writer show recovery between files
  }
  await writer.stop();
  await db.end();

  const baseline = writer.samples.filter(s => !results.length || s.at < results[0].started);
  const pct = (arr, p) => arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : null;
  for (const r of results) {
    // A write that started before the migration ended can have waited on it.
    const during = writer.samples.filter(s => s.at + s.ms >= r.started && s.at <= r.ended).map(s => s.ms);
    r.concurrentWrites = during.length;
    r.maxWriteMs = during.length ? Math.max(...during) : null;
  }
  const report = {
    postgres: version, rows, populateMs, sizes: flag('--populate') ? sizes : null,
    baselineWrite: { samples: baseline.length, p50: pct(baseline.map(s => s.ms), 0.5), p99: pct(baseline.map(s => s.ms), 0.99) },
    migrations: results,
  };
  const out = arg('--json', null);
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));

  console.log(`PostgreSQL ${version}; rows: ${Object.entries(rows).map(([t, n]) => `${t}=${n}`).join(', ')}`);
  console.log(`baseline write (insert message + report): p50 ${report.baselineWrite.p50?.toFixed(2)} ms, p99 ${report.baselineWrite.p99?.toFixed(2)} ms`);
  console.log('| Migration | Time (ms) | Max concurrent write (ms) | Locks held until commit (strongest mode) |');
  console.log('|---|---:|---:|---|');
  for (const r of results) {
    const locks = r.locks.map(l => `${l.relation}: ${l.mode}${l.blocksReads ? ' (blocks reads+writes)' : l.blocksWrites ? ' (blocks writes)' : ''}`).join('; ');
    console.log(`| ${r.file} | ${r.ms.toFixed(1)} | ${r.maxWriteMs === null ? 'n/a' : r.maxWriteMs.toFixed(1)} | ${locks || '—'} |`);
  }
}

main().catch(err => { console.error(err.message); process.exit(1); });
