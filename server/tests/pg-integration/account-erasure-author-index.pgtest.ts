// server/tests/pg-integration/account-erasure-author-index.pgtest.ts
//
// Real PostgreSQL: account erasure finds a person's messages by index, not by
// scanning every message (migration 094).
//
// eraseAccountData filters `messages` and `thread_messages` by "userId" and
// scrubs quote headers by "replyTo"->>'_id'. Without 094 those statements scan
// the whole table inside the erasure transaction: 1.9-2.7 s at 6M messages,
// 0.16-0.20 s with the indexes (docs/P7_D1_PARTITION_DECISION.md).
//
// What is checked is the plan, not a timing: the real eraseAccountData runs in a
// transaction that is always rolled back, and before each statement executes the
// same statement with the same parameters is EXPLAINed. No plan may contain a
// sequential scan of `messages` or `thread_messages`, and each 094 index must
// appear in some plan. The negative control drops the indexes inside the same
// kind of rolled-back transaction and expects the sequential scans back, so the
// assertion is shown to detect the regression it guards.
//
// Runs only with PG_TEST_URL and deletes its own rows.

import { eraseAccountData, type Queryable, type TransactionRunner } from '../../lib/accountDeletion';

const db = require('../../db/loader').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const P = 'pgt-eidx';
const TARGET = `${P}-u-1`;
const AUTHORS = 400;
const MESSAGES = 40_000;
const THREAD_MESSAGES = 8_000;
const INDEXES = ['idx_messages_author', 'idx_messages_reply_quote_ref', 'idx_thread_messages_author'];
const ROLLED_BACK = Symbol('rolled back');

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; Plans?: PlanNode[] };

function walk(node: PlanNode, out: PlanNode[] = []): PlanNode[] {
  out.push(node);
  for (const child of node.Plans ?? []) walk(child, out);
  return out;
}

RUN('real PostgreSQL: account erasure uses the 094 author indexes', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;

  const cleanup = async () => {
    const like = `${P}-%`;
    for (const t of ['thread_messages', 'threads', 'messages', 'channels']) await q(`DELETE FROM ${t} WHERE _id LIKE $1`, [like]);
    await q(`DELETE FROM servers WHERE _id LIKE $1`, [like]);
    await q(`DELETE FROM users WHERE _id LIKE $1`, [like]);
  };

  beforeAll(async () => {
    await cleanup();
    await q(
      `INSERT INTO users (_id, username, password, "displayName", "createdAt")
       SELECT '${P}-u-' || g, 'pgt_eidx_u_' || g, 'x', 'u', 1 FROM generate_series(1, ${AUTHORS}) g`,
    );
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'eidx', $2, 1)`, [`${P}-srv`, `${P}-u-2`]);
    await q(
      `INSERT INTO channels (_id, "serverId", name, "createdAt")
       SELECT '${P}-c-' || g, $1, 'c' || g, 1 FROM generate_series(1, 20) g`,
      [`${P}-srv`],
    );
    // Authors round-robin, so the target owns 1/400 of the rows; every tenth
    // message quotes the one before it, with the author name in the header.
    await q(
      `INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt", "replyTo")
       SELECT '${P}-m-' || g, '${P}-c-' || (1 + g % 20), $1, '${P}-u-' || (1 + g % ${AUTHORS}), 'u', 'U', 'm', g,
              CASE WHEN g % 10 = 0
                   THEN jsonb_build_object('_id', '${P}-m-' || (g - 1), 'displayName', 'U', 'content', 'm')
              END
       FROM generate_series(1, ${MESSAGES}) g`,
      [`${P}-srv`],
    );
    await q(
      `INSERT INTO threads (_id, "channelId", "serverId", "parentMessageId", name, "createdBy", "createdAt", "lastMessageAt")
       VALUES ($1, $2, $3, $4, 't', $5, 1, 1)`,
      [`${P}-t-1`, `${P}-c-1`, `${P}-srv`, `${P}-m-20`, `${P}-u-2`],
    );
    await q(
      `INSERT INTO thread_messages (_id, "threadId", "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
       SELECT '${P}-tm-' || g, $1, $2, $3, '${P}-u-' || (1 + g % ${AUTHORS}), 'u', 'U', 'm', g
       FROM generate_series(1, ${THREAD_MESSAGES}) g`,
      [`${P}-t-1`, `${P}-c-1`, `${P}-srv`],
    );
    await q('ANALYZE messages');
    await q('ANALYZE thread_messages');
  }, 120_000);

  afterAll(async () => {
    await cleanup();
    try { await db._pool.end(); } catch { /* already closed */ }
  });

  /**
   * Runs the real erasure for TARGET in a rolled-back transaction and returns,
   * per statement that touches messages/thread_messages, its plan nodes.
   */
  const erasurePlans = async (setup?: (client: Queryable) => Promise<void>) => {
    const plans: Array<{ sql: string; nodes: PlanNode[] }> = [];
    const runner: TransactionRunner = async <T>(fn: (client: Queryable) => Promise<T>): Promise<T> => {
      const client = await db._pool.connect();
      const explaining: Queryable = {
        query: (async (sql: string, params?: unknown[]) => {
          if (/\b(messages|thread_messages)\b/.test(sql) && /^\s*(SELECT|UPDATE|DELETE|WITH)\b/i.test(sql)) {
            const r = await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params);
            plans.push({ sql: sql.replace(/\s+/g, ' ').trim(), nodes: walk(r.rows[0]['QUERY PLAN'][0].Plan) });
          }
          return client.query(sql, params);
        }) as Queryable['query'],
      };
      try {
        await client.query('BEGIN');
        if (setup) await setup(client);
        await fn(explaining);
        throw ROLLED_BACK;
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    };
    try {
      await eraseAccountData(db._pool, runner, TARGET, { purgeChannelMessages: false });
    } catch (err) {
      if (err !== ROLLED_BACK) throw err;
    }
    return plans;
  };

  const seqScans = (plans: Array<{ sql: string; nodes: PlanNode[] }>) =>
    plans.flatMap(p => p.nodes
      .filter(n => n['Node Type'] === 'Seq Scan' && /^(messages|thread_messages)$/.test(n['Relation Name'] ?? ''))
      .map(n => `${n['Relation Name']}: ${p.sql.slice(0, 120)}`));

  test('the indexes exist, on the columns erasure filters by', async () => {
    const rows = await q(
      `SELECT indexname, indexdef FROM pg_indexes WHERE indexname = ANY($1) ORDER BY indexname`, [INDEXES]);
    expect(rows.map((r: { indexname: string }) => r.indexname)).toEqual([...INDEXES].sort());
    const def = Object.fromEntries(rows.map((r: { indexname: string; indexdef: string }) => [r.indexname, r.indexdef]));
    expect(def.idx_messages_author).toMatch(/ON public\.messages USING btree \("userId"\)$/);
    expect(def.idx_messages_reply_quote_ref).toMatch(/USING btree \(\(\("replyTo" ->> '_id'::text\)\)\) WHERE \("replyTo" \? 'displayName'::text\)$/);
    expect(def.idx_thread_messages_author).toMatch(/ON public\.thread_messages USING btree \("userId"\)$/);
  });

  test('no erasure statement scans messages or thread_messages sequentially', async () => {
    const plans = await erasurePlans();
    // The author lookups really are in the erasure: if a refactor removed them
    // this test would pass vacuously.
    expect(plans.some(p => /FROM messages WHERE "userId" = \$1/.test(p.sql))).toBe(true);
    expect(plans.some(p => /thread_messages/.test(p.sql) && /"userId" = \$1/.test(p.sql))).toBe(true);
    expect(seqScans(plans)).toEqual([]);
    const used = new Set(plans.flatMap(p => p.nodes.map(n => n['Index Name']).filter(Boolean)));
    for (const name of INDEXES) expect(used).toContain(name);
  }, 60_000);

  test('negative control: without the indexes the same erasure scans both tables', async () => {
    const plans = await erasurePlans(async (client) => {
      for (const name of INDEXES) await client.query(`DROP INDEX ${name}`);
    });
    const scans = seqScans(plans);
    expect(scans.some(s => s.startsWith('messages:'))).toBe(true);
    expect(scans.some(s => s.startsWith('thread_messages:'))).toBe(true);
    // The drop was rolled back with the transaction.
    expect((await q(`SELECT count(*)::int AS n FROM pg_indexes WHERE indexname = ANY($1)`, [INDEXES]))[0].n).toBe(INDEXES.length);
  }, 60_000);
});
