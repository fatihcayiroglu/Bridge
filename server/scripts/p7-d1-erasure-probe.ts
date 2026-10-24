// server/scripts/p7-d1-erasure-probe.ts
//
// P7 D1: how long account erasure (lib/accountDeletion.ts eraseAccountData)
// takes on a populated DISPOSABLE database, statement by statement. It runs
// the production function through a transaction runner that always rolls back,
// so the dataset is unchanged and every user can be measured.
//
// Erasure filters messages, thread_messages and the DM tables by "userId", and
// those tables have no index on it. This measures what that costs at a given
// size, with and without the admin purge of channel messages.
//
//   P7_D1_DISPOSABLE_ACK=I_UNDERSTAND PG_URL=postgresql://user@host/d1_bench \
//     npx ts-node --project tsconfig.json scripts/p7-d1-erasure-probe.ts [--json out.json]
//
// Only databases named d1_* are accepted. Statement text is printed without
// parameters, so no user id appears in the output.

import fs from 'fs';
import { Pool } from 'pg';
import { eraseAccountData, type Queryable, type TransactionRunner } from '../lib/accountDeletion';

const ROLLED_BACK = Symbol('rolled back');

async function main(): Promise<void> {
  if (process.env.P7_D1_DISPOSABLE_ACK !== 'I_UNDERSTAND') throw new Error('Set P7_D1_DISPOSABLE_ACK=I_UNDERSTAND');
  const pool = new Pool({ connectionString: process.env.PG_URL });
  const db = (await pool.query('SELECT current_database() AS d')).rows[0].d as string;
  if (!/^d1_/.test(db)) throw new Error(`refusing to run on "${db}": the database name must start with d1_`);

  // The busiest author and a median one.
  const authors = (await pool.query(`
    WITH per AS (SELECT "userId", count(*) AS n FROM messages GROUP BY 1)
    (SELECT "userId", n FROM per ORDER BY n DESC LIMIT 1)
    UNION ALL
    (SELECT "userId", n FROM per ORDER BY n LIMIT 1 OFFSET (SELECT count(*) / 2 FROM per))`)).rows as Array<{ userId: string; n: string }>;
  const rows = Number((await pool.query('SELECT reltuples::bigint AS n FROM pg_class WHERE relname = $1', ['messages'])).rows[0].n);

  const results: Array<Record<string, unknown>> = [];
  for (const [label, author] of [['busiest', authors[0]], ['median', authors[1]]] as const) {
    for (const purge of [false, true]) {
      const statements: Array<{ sql: string; ms: number; rows: number }> = [];
      const runner: TransactionRunner = async <T>(fn: (client: Queryable) => Promise<T>): Promise<T> => {
        const client = await pool.connect();
        const timed: Queryable = {
          query: (async (sql: string, params?: unknown[]) => {
            const t0 = process.hrtime.bigint();
            const r = await client.query(sql, params as unknown[]);
            statements.push({ sql: sql.replace(/\s+/g, ' ').trim().slice(0, 110), ms: Number(process.hrtime.bigint() - t0) / 1e6, rows: r.rowCount ?? 0 });
            return r;
          }) as Queryable['query'],
        };
        try {
          await client.query('BEGIN');
          await fn(timed);
          throw ROLLED_BACK;
        } finally {
          await client.query('ROLLBACK').catch(() => undefined);
          client.release();
        }
      };
      const t0 = process.hrtime.bigint();
      try {
        await eraseAccountData(pool as unknown as Queryable, runner, author.userId, { purgeChannelMessages: purge });
      } catch (err) {
        if (err !== ROLLED_BACK) throw err;
      }
      const totalMs = Number(process.hrtime.bigint() - t0) / 1e6;
      const slowest = statements.slice().sort((a, b) => b.ms - a.ms).slice(0, 6)
        .map(s => ({ ...s, ms: Math.round(s.ms) }));
      results.push({ author: label, authoredMessages: Number(author.n), purgeChannelMessages: purge,
        totalMs: Math.round(totalMs), statements: statements.length, slowest });
    }
  }
  const report = { database: 'd1_*', messagesEstimate: rows, results };
  const out = process.argv.indexOf('--json');
  if (out > 0) fs.writeFileSync(process.argv[out + 1], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  await pool.end();
}

main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
