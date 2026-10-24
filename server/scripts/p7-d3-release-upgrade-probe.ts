// server/scripts/p7-d3-release-upgrade-probe.ts
//
// P7 D3: can a database created by the last tagged release (v1.122.0, chain at
// 017) be brought to the current schema, and what does it cost? Point it at a
// DISPOSABLE database that the release built (and optionally populated).
//
//   P7_D3_DISPOSABLE_ACK=I_UNDERSTAND PG_URL=postgresql://user@host/d3_x \
//     npx ts-node --transpile-only scripts/p7-d3-release-upgrade-probe.ts <mode>
//
// Modes:
//   schema-check  Runs every statement of the current schema.ts, each under its
//                 own SAVEPOINT inside one transaction that is ROLLED BACK, and
//                 lists the statements the database refuses. Boot runs schema.ts
//                 as ONE query before the versioned chain, so any refusal here
//                 means the current boot cannot start on this database.
//   chain-first   Applies the pending versioned chain with no schema pass first,
//                 one transaction per file as production does, and reports
//                 where it stops. Changes the database.
//   staged        Tolerant schema pass (refused statements skipped), inline
//                 steps, the pending chain with per-file times, then the strict
//                 schema pass and inline steps as boot runs them. Changes the
//                 database. This is NOT what Bridge does today; it measures a
//                 candidate repair, so its result is evidence, not a supported path.
//
// Only databases named d3_* are accepted. Output carries statement text and
// timings, never row data.

import { Pool } from 'pg';
import { applyPendingMigrations } from '../db/postgres/versionedMigrations';
import { runInlineMigrations } from '../db/postgres/migrations';
import { SCHEMA } from '../db/postgres/schema';

/** Splits schema.ts into statements; respects comments, quotes and $$ bodies. */
export function splitSql(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let dollar: string | null = null;
  let i = 0;
  while (i < sql.length) {
    if (!dollar && sql.startsWith('--', i)) {
      const j = sql.indexOf('\n', i);
      i = j < 0 ? sql.length : j;
      continue;
    }
    if (!dollar && sql[i] === "'") {
      const j = sql.indexOf("'", i + 1);
      cur += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const tag = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (tag) {
      if (!dollar) dollar = tag[0];
      else if (dollar === tag[0]) dollar = null;
      cur += tag[0];
      i += tag[0].length;
      continue;
    }
    if (!dollar && sql[i] === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += sql[i];
    i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const brief = (s: string) => s.replace(/\s+/g, ' ').slice(0, 140);

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (!['schema-check', 'chain-first', 'staged'].includes(mode ?? '')) {
    throw new Error('mode must be schema-check, chain-first or staged');
  }
  if (process.env.P7_D3_DISPOSABLE_ACK !== 'I_UNDERSTAND') throw new Error('Set P7_D3_DISPOSABLE_ACK=I_UNDERSTAND');
  const pool = new Pool({ connectionString: process.env.PG_URL, max: 2 });
  const db = (await pool.query('SELECT current_database() AS d')).rows[0].d as string;
  if (!/^d3_/.test(db)) throw new Error(`refusing to run on "${db}": the database name must start with d3_`);
  const t0 = Date.now();
  const lap = (s: string) => console.log(`${String(Date.now() - t0).padStart(7)} ms  ${s}`);
  const statements = splitSql(SCHEMA);

  if (mode === 'schema-check') {
    const c = await pool.connect();
    let refused = 0;
    try {
      await c.query('BEGIN');
      for (const s of statements) {
        await c.query('SAVEPOINT s');
        try {
          await c.query(s);
          await c.query('RELEASE SAVEPOINT s');
        } catch (err) {
          refused++;
          const e = err as { code?: string; message?: string };
          console.log(`REFUSED ${e.code} ${e.message} :: ${brief(s)}`);
          await c.query('ROLLBACK TO SAVEPOINT s');
        }
      }
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    lap(`schema.ts: ${statements.length} statements, ${refused} refused (rolled back)`);
  } else if (mode === 'chain-first') {
    const c = await pool.connect();
    try {
      let last = Date.now();
      const applied = await applyPendingMigrations(c, {
        onApplied: (f) => { console.log(`FILE ${Date.now() - last} ms ${f}`); last = Date.now(); },
      });
      lap(`chain applied: ${applied.length} files`);
    } catch (err) {
      lap(`chain STOPPED: ${(err as Error).message}`);
    } finally {
      c.release();
    }
  } else {
    let skipped = 0;
    for (const s of statements) {
      try { await pool.query(s); } catch { skipped++; }
    }
    lap(`tolerant schema pass: ${skipped} statements skipped`);
    await runInlineMigrations(pool);
    lap('inline steps');
    const c = await pool.connect();
    try {
      let last = Date.now();
      const applied = await applyPendingMigrations(c, {
        onApplied: (f) => { console.log(`FILE ${Date.now() - last} ms ${f}`); last = Date.now(); },
      });
      lap(`chain applied: ${applied.length} files`);
    } finally {
      c.release();
    }
    await pool.query(SCHEMA);
    lap('strict schema pass (as boot runs it)');
    await runInlineMigrations(pool);
    lap('inline steps again');
  }
  await pool.end();
}

if (require.main === module) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
