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
  // Created by migration 006 and DROPPED by 009 (plaintext private key). Never allowlist it.
  apPrivateKey: 'plaintext ActivityPub private key column, dropped by migration 009',
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
});
