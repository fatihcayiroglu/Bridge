#!/usr/bin/env node
'use strict';
// P7 D1: non-mutating PostgreSQL capacity evidence. No message content or
// identities are retrieved, logged, or stored. Use a read-only database role.
const TABLES = Object.freeze(['messages', 'dm_messages', 'thread_messages', 'members', 'channels']);
const TABLE_SET = new Set(TABLES);
const PROBES = Object.freeze([
  { name: 'message_channel_cursor', table: 'messages', sql: 'SELECT _id FROM public.messages WHERE "channelId" = $1 ORDER BY "createdAt" DESC, _id DESC LIMIT 50', env: 'P7_CHANNEL_PROBE_ID' },
  { name: 'member_server_cursor', table: 'members', sql: 'SELECT "userId" FROM public.members WHERE "serverId" = $1 ORDER BY "joinedAt", "userId" LIMIT 50', env: 'P7_SERVER_PROBE_ID' },
]);
const SIZE_SQL = `SELECT c.relname AS table_name, c.reltuples::bigint AS estimated_rows,
  pg_relation_size(c.oid)::bigint AS heap_bytes,
  pg_indexes_size(c.oid)::bigint AS index_bytes,
  pg_total_relation_size(c.oid)::bigint AS total_bytes,
  COALESCE(s.n_live_tup, 0)::bigint AS stat_live_rows,
  COALESCE(s.n_dead_tup, 0)::bigint AS stat_dead_rows,
  s.last_analyze IS NOT NULL OR s.last_autoanalyze IS NOT NULL AS analyzed,
  (c.relkind = 'p') AS partitioned,
  (SELECT COUNT(*)::int FROM pg_inherits i WHERE i.inhparent = c.oid) AS partitions
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname = ANY($1::text[])
ORDER BY c.relname`;
const INDEX_SQL = `SELECT t.relname AS table_name, ix.relname AS index_name,
  pg_relation_size(ix.oid)::bigint AS index_bytes,
  COALESCE(st.idx_scan,0)::bigint AS scans
FROM pg_class t JOIN pg_namespace n ON n.oid = t.relnamespace
JOIN pg_index i ON i.indrelid = t.oid
JOIN pg_class ix ON ix.oid = i.indexrelid
LEFT JOIN pg_stat_user_indexes st ON st.indexrelid = ix.oid
WHERE n.nspname = 'public' AND t.relname = ANY($1::text[])
ORDER BY t.relname, ix.relname`;
function safeCount(value) {
  const x = Number(value);
  if (!Number.isSafeInteger(x) || x < 0) throw new Error('invalid catalog counter');
  return x;
}
// PostgreSQL reports reltuples=-1 when no useful row estimate exists.
// Treat it as UNKNOWN, never silently as an empty table.
function safeEstimatedRows(value) {
  if (value === null || value === undefined || value === '') throw new Error('missing catalog row estimate');
  const x = Number(value);
  if (x === -1) return null;
  if (!Number.isSafeInteger(x) || x < 0) throw new Error('invalid catalog row estimate');
  return x;
}
function safeTable(raw) {
  if (!TABLE_SET.has(raw)) throw new Error('unexpected table returned by catalog query');
  return raw;
}
function safeIndex(raw) {
  if (typeof raw !== 'string' || !/^[a-zA-Z0-9_]{1,128}$/.test(raw)) throw new Error('invalid catalog index name');
  return raw;
}
function normalizedTables(rows) {
  const visited = new Set();
  const found = rows.map(r => {
    const table = safeTable(r.table_name);
    if (visited.has(table)) throw new Error('duplicate table catalog row');
    visited.add(table);
    return {
      table, estimatedRows: safeEstimatedRows(r.estimated_rows),
      statLiveRows: safeCount(r.stat_live_rows), statDeadRows: safeCount(r.stat_dead_rows),
      heapBytes: safeCount(r.heap_bytes), indexBytes: safeCount(r.index_bytes),
      totalBytes: safeCount(r.total_bytes), analyzed: r.analyzed === true,
      partitioned: r.partitioned === true, partitions: safeCount(r.partitions),
    };
  });
  return found.sort((a,b) => a.table.localeCompare(b.table));
}
function normalizedIndexes(rows) {
  return rows.map(r => ({
    table: safeTable(r.table_name), index: safeIndex(r.index_name),
    bytes: safeCount(r.index_bytes), scansSinceStatsReset: safeCount(r.scans),
  }));
}
// EXPLAIN (no ANALYZE) emits plan nodes/index names/estimates only: never SQL,
// filter values, raw JSON or records. Estimates are not runtime benchmarks.
function summarizePlan(input) {
  const root = Array.isArray(input) ? input[0]?.Plan : input?.Plan;
  if (!root || typeof root !== 'object') throw new Error('missing EXPLAIN plan');
  const nodes = [];
  const visit = (node, depth) => {
    if (depth > 24 || nodes.length >= 64) throw new Error('EXPLAIN plan exceeds bound');
    const type = node['Node Type'];
    if (typeof type !== 'string' || !/^[A-Za-z ]{1,64}$/.test(type)) throw new Error('invalid EXPLAIN node');
    const detail = { type, estimatedRows: safeCount(Math.trunc(node['Plan Rows'])), estimatedCost: Number(node['Total Cost']) };
    if (!Number.isFinite(detail.estimatedCost) || detail.estimatedCost < 0) throw new Error('invalid estimated plan cost');
    if (node['Index Name']) detail.index = safeIndex(node['Index Name']);
    nodes.push(detail);
    for (const child of (node.Plans || [])) visit(child, depth + 1);
  };
  visit(root, 0);
  return nodes;
}
async function collectEvidence(client, env) {
  await client.query('BEGIN TRANSACTION READ ONLY');
  try {
    await client.query("SET LOCAL statement_timeout = '5000ms'");
    await client.query("SET LOCAL lock_timeout = '1000ms'");
    const metrics = normalizedTables((await client.query(SIZE_SQL, [TABLES])).rows);
    const indexes = normalizedIndexes((await client.query(INDEX_SQL, [TABLES])).rows);
    const plans = [];
    for (const probe of PROBES) {
      const actual = env[probe.env];
      // Never echo real probe IDs to evidence JSON or CI logs.
      const representative = typeof actual === 'string' && actual.length > 0;
      const argument = representative ? actual : '__bridge_p7_synthetic_probe__';
      const row = (await client.query('EXPLAIN (FORMAT JSON, ANALYZE FALSE) ' + probe.sql, [argument])).rows[0];
      plans.push({name:probe.name, inputKind:representative ? 'operator-supplied' : 'synthetic', nodes:summarizePlan(row['QUERY PLAN'])});
    }
    await client.query('COMMIT');
    return {schema: 'p7-d1-assessment-v1', readOnly: true,
      caveat: 'Catalog row counts are estimates; plans are EXPLAIN only, not runtime benchmarks. No partition recommendation is inferred.',
      tables:metrics, indexes, plans};
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
async function main() {
  if (process.env.P7_D1_READ_ONLY_ACK !== 'I_UNDERSTAND') throw new Error('Set P7_D1_READ_ONLY_ACK=I_UNDERSTAND');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required (use a read-only database role)');
  const {Client} = require('pg');
  const client = new Client({connectionString:process.env.DATABASE_URL, application_name:'bridge-p7-d1-readonly'});
  try {
    await client.connect();
    const evidence = await collectEvidence(client, process.env);
    process.stdout.write(JSON.stringify(evidence, null, 2) + '\n');
  } finally {await client.end().catch(() => {});}
}
if (require.main === module) {
  main().catch(() => {console.error('P7 D1 assessment failed; no database details printed');process.exitCode = 1;});
}
module.exports = {TABLES, PROBES, SIZE_SQL, INDEX_SQL, normalizedTables, normalizedIndexes, summarizePlan, collectEvidence};
