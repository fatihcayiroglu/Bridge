// server/tests/allowed-columns-schema-coverage.test.ts — Final21 Phase 16.
//
// pgCollection refuses any column name that is not in ALLOWED_COLUMNS (an injection guard).
// The guard is right; forgetting to extend it is not. A real schema column missing from the
// set makes every repository read/write that names it throw — at runtime only, because the
// unit-test mock DB has no allowlist.
//
// Measured twice: `bot_marketplace."executableBotId"` (noted in pgCollection.ts) and, in
// Phase 16, `messages."contentFormat"` — every channel message send failed on the live server
// ("Unknown column name") while all unit tests stayed green.
//
// This test derives the columns from the schema sources themselves and requires each one to be
// allowlisted, except columns deliberately kept unreachable, which must be named here.

import fs from 'fs';
import path from 'path';

const SERVER = path.resolve(__dirname, '..');

/** Columns that exist in SOME schema source but must never be reachable through pgCollection. */
const DELIBERATELY_UNREACHABLE: Record<string, string> = {
  // P7 D2 migration 089: never written through the generic PgCollection.
  enqueuedAt: '089 channel_object_release_outbox: the expiry worker\'s own queue, raw parameterized SQL only (lib/channelExpiryWorker.ts)',
  state: '089 channel_object_release_outbox: the expiry worker\'s own queue, raw parameterized SQL only (lib/channelExpiryWorker.ts)',
  nextAttemptAt: '089 channel_object_release_outbox: the expiry worker\'s own queue, raw parameterized SQL only (lib/channelExpiryWorker.ts)',
  finishedAt: '089 channel_object_release_outbox: the expiry worker\'s own queue, raw parameterized SQL only (lib/channelExpiryWorker.ts)',
  // Created by migration 006 and DROPPED by 009 (plaintext private key). Never allowlist it.
  apPrivateKey: 'plaintext ActivityPub private key column, dropped by migration 009',
  token_hash: '081 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  target_server_id: '081 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  owner_id: '081 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  review_fingerprint: '081 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  target_topology_digest: '081 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  target_grant_digest: '082 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  source_origin: '081 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  source_server_id: '081 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  source_snapshot_id: '081 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  source_key_fingerprint: '081 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  structure_digest: '081 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  permissions_digest: '081 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  expires_at: '081 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  consumed_at: '081 portable_import_approvals: sensitive, dedicated parameterized SQL only; do not expose via generic PgCollection',
  committed_at: '083 portable_import_snapshot_consumptions: replay barrier committed timestamp, dedicated parameterized SQL only; no generic PgCollection',
};

function allowedColumns(): Set<string> {
  const src = fs.readFileSync(path.join(SERVER, 'db/postgres/pgCollection.ts'), 'utf8');
  const start = src.indexOf('const ALLOWED_COLUMNS = new Set([');
  const body = src.slice(start, src.indexOf(']);', start));
  // Comments inside the literal contain apostrophes; strip them before pairing quotes.
  const code = body.split('\n').map((line) => { const i = line.indexOf('//'); return i >= 0 ? line.slice(0, i) : line; }).join('\n');
  return new Set([...code.matchAll(/'([^']+)'/g)].map((m) => m[1]));
}

function schemaColumns(): Map<string, string[]> {
  const files = [
    'db/postgres/schema.ts',
    'db/postgres/migrations.ts',
    ...fs.readdirSync(path.join(SERVER, 'db/migrations_pg')).filter((f) => f.endsWith('.sql')).map((f) => `db/migrations_pg/${f}`),
  ];
  const columns = new Map<string, string[]>();
  const add = (col: string, where: string) => {
    if (/^(PRIMARY|UNIQUE|CONSTRAINT|FOREIGN|CHECK|EXCLUDE|AND|OR|NOT)$/i.test(col)) return;
    columns.set(col, [...(columns.get(col) ?? []), where]);
  };
  for (const file of files) {
    const src = fs.readFileSync(path.join(SERVER, file), 'utf8');
    for (const m of src.matchAll(/CREATE TABLE IF NOT EXISTS\s+("?\w+"?)\s*\(([\s\S]*?)\n\s*\)\s*[;`]/gi)) {
      const table = m[1].replace(/"/g, '');
      for (const line of m[2].split('\n')) {
        const cm = line.trim().match(/^("?)([A-Za-z_]\w*)\1\s+[A-Za-z]/);
        if (cm) add(cm[2], `${table} (${file})`);
      }
    }
    for (const m of src.matchAll(/ALTER TABLE\s+("?\w+"?)\s+ADD COLUMN(?: IF NOT EXISTS)?\s+("?)([A-Za-z_]\w*)\2/gi)) {
      add(m[3], `${m[1].replace(/"/g, '')} (${file})`);
    }
  }
  return columns;
}

describe('ALLOWED_COLUMNS covers the real schema', () => {
  const allowed = allowedColumns();
  const columns = schemaColumns();

  it('the parser actually sees the schema (guards against a silently empty scan)', () => {
    expect(columns.size).toBeGreaterThan(300);
    expect(allowed.size).toBeGreaterThan(300);
    expect(columns.has('contentFormat')).toBe(true);
  });

  it('every schema column is allowlisted, or named here as deliberately unreachable', () => {
    const missing = [...columns.keys()].filter((col) => !allowed.has(col) && !(col in DELIBERATELY_UNREACHABLE));
    expect(missing.map((col) => `${col} <- ${columns.get(col)!.slice(0, 2).join(', ')}`)).toEqual([]);
  });

  it('a deliberately unreachable column is really NOT allowlisted', () => {
    for (const col of Object.keys(DELIBERATELY_UNREACHABLE)) expect(allowed.has(col)).toBe(false);
  });

  it('every exception still exists in some schema source (no stale exceptions)', () => {
    for (const col of Object.keys(DELIBERATELY_UNREACHABLE)) expect(columns.has(col)).toBe(true);
  });

  it('083 replay ledger timestamp stays strictly SQL-only and durable', () => {
    const migration = fs.readFileSync(path.join(SERVER,
      'db/migrations_pg/083_portable_import_snapshot_replay_barrier.sql'), 'utf8');
    const owner = fs.readFileSync(path.join(SERVER, 'lib/portableAtomicMappedApply.ts'), 'utf8');
    expect(columns.get('committed_at'))
      .toContain('portable_import_snapshot_consumptions (db/migrations_pg/083_portable_import_snapshot_replay_barrier.sql)');
    expect(allowed.has('committed_at')).toBe(false);
    expect(DELIBERATELY_UNREACHABLE.committed_at).toContain('dedicated parameterized SQL');
    expect(migration).toMatch(/committed_at\s+TIMESTAMPTZ\s+NOT NULL DEFAULT clock_timestamp\(\)/);
    expect(owner).toContain('portable_import_snapshot_consumptions');
  });

  it('082 grant digest is present only in the consent ledger extension and dedicated SQL', () => {
    const migration = fs.readFileSync(path.join(SERVER,
      'db/migrations_pg/082_portable_import_approval_grant_binding.sql'), 'utf8');
    const owner = fs.readFileSync(path.join(SERVER, 'lib/portableImportApprovalLedger.ts'), 'utf8');
    expect(columns.get('target_grant_digest'))
      .toContain('portable_import_approvals (db/migrations_pg/082_portable_import_approval_grant_binding.sql)');
    expect(allowed.has('target_grant_digest')).toBe(false);
    expect(DELIBERATELY_UNREACHABLE.target_grant_digest).toContain('dedicated parameterized SQL');
    expect(migration).toContain('target_grant_digest');
    expect(owner).toContain('target_grant_digest');
    expect(owner).toContain('AND a.target_grant_digest=$6');
  });

  it('081 consent ledger columns remain SQL-only, with no generic collection access', () => {
    const ledger = fs.readFileSync(path.join(SERVER, 'db/migrations_pg/081_portable_import_approval_ledger.sql'), 'utf8');
    const owner = fs.readFileSync(path.join(SERVER, 'lib/portableImportApprovalLedger.ts'), 'utf8');
    const privileged = [
      'token_hash', 'target_server_id', 'owner_id', 'review_fingerprint',
      'target_topology_digest', 'source_origin', 'source_server_id',
      'source_snapshot_id', 'source_key_fingerprint', 'structure_digest',
      'permissions_digest', 'expires_at', 'consumed_at',
    ];
    expect(privileged).toHaveLength(13);
    for (const col of privileged) {
      expect(columns.get(col)).toContain('portable_import_approvals (db/migrations_pg/081_portable_import_approval_ledger.sql)');
      expect(allowed.has(col)).toBe(false);
      expect(DELIBERATELY_UNREACHABLE[col]).toContain('dedicated parameterized SQL');
      expect(ledger).toContain(col);
      expect(owner).toContain(col);
    }
    expect(ledger).toMatch(/token_hash\s+TEXT\s+PRIMARY\s+KEY/);
    expect(ledger).toMatch(/target_server_id\s+TEXT\s+NOT NULL REFERENCES servers\(_id\) ON DELETE CASCADE/);
    expect(owner).toContain('UPDATE portable_import_approvals');
    expect(owner).toContain('consumed_at IS NULL');
  });
});
