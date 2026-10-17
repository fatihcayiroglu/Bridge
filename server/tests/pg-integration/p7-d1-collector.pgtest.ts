// P7 D1: the read-only collector must actually execute on PostgreSQL.
// Mock tests prove redaction contracts, but cannot prove catalog SQL and EXPLAIN
// syntax. This suite runs with the mandatory PG_TEST_URL integration gate;
// no production identifiers, row data or changes are permitted.
import { Client } from 'pg';

type Assessment = {
  schema: string;
  readOnly: boolean;
  tables: Array<{ table: string; estimatedRows: number | null; totalBytes: number }>;
  indexes: Array<{ table: string; index: string; bytes: number }>;
  plans: Array<{ name: string; inputKind: string; nodes: Array<{ type: string }> }>;
};
const { collectEvidence } = require('../../scripts/p7-partition-assessment.cjs') as {
  collectEvidence: (db: unknown, env: Record<string, string>) => Promise<Assessment>;
};
const PG_URL = process.env.PG_TEST_URL;
let client: Client;
let db: { _initSchema: () => Promise<void>; _pool: { end: () => Promise<void> } };

describe('P7 D1 — live PostgreSQL read-only catalog and planner evidence', () => {
  beforeAll(async () => {
    if (!PG_URL) throw new Error('PG_TEST_URL required; live D1 evidence cannot be skipped');
    // Integration setup selects the real PostgreSQL driver, not the test mock.
    db = require('../../db/loader').default;
    await db._initSchema();
    client = new Client({ connectionString: PG_URL, application_name: 'bridge-p7-d1-live-test' });
    await client.connect();
  }, 120_000);

  afterAll(async () => {
    if (client) await client.end();
    if (db?._pool) await db._pool.end();
  });

  it('executes real pg_class/pg_stat catalog queries and both EXPLAIN plans', async () => {
    const evidence = await collectEvidence(client, {});
    expect(evidence.schema).toBe('p7-d1-assessment-v1');
    expect(evidence.readOnly).toBe(true);
    expect(new Set(evidence.tables.map((row) => row.table))).toEqual(
      new Set(['messages', 'dm_messages', 'thread_messages', 'members', 'channels']),
    );
    expect(evidence.tables.every((row) =>
      row.estimatedRows === null || (Number.isSafeInteger(row.estimatedRows) && row.estimatedRows >= 0)
    )).toBe(true);
    expect(evidence.tables.every((row) => row.totalBytes >= 0)).toBe(true);
    expect(evidence.indexes.length).toBeGreaterThan(0);
    expect(evidence.plans.map((plan) => plan.name)).toEqual([
      'message_channel_cursor', 'member_server_cursor',
    ]);
    expect(evidence.plans.every((plan) =>
      plan.inputKind === 'synthetic' && plan.nodes.length > 0
    )).toBe(true);

    // The connection must be back outside a read-only transaction after COMMIT.
    const state = await client.query('SHOW transaction_read_only');
    expect(state.rows[0].transaction_read_only).toBe('off');
  });

  it('does not echo representative probe identities or raw plan filter expressions', async () => {
    const secretA = 'd1-sensitive-channel-id-should-never-appear';
    const secretB = 'd1-sensitive-server-id-should-never-appear';
    const evidence = await collectEvidence(client, {
      P7_CHANNEL_PROBE_ID: secretA,
      P7_SERVER_PROBE_ID: secretB,
    });
    expect(evidence.plans.map((plan) => plan.inputKind)).toEqual([
      'operator-supplied', 'operator-supplied',
    ]);
    expect(JSON.stringify(evidence)).not.toMatch(/d1-sensitive|Index Cond|Filter|SELECT |userId|channelId/);
  });

  it('rolls back an interrupted catalog transaction and leaves the connection reusable', async () => {
    let interrupted = false;
    const faultyClient = {
      query: async (sql: string, params?: unknown[]) => {
        if (!interrupted && sql.includes('pg_stat_user_indexes')) {
          interrupted = true;
          throw new Error('synthetic collector failure before index query');
        }
        return client.query(sql, params);
      },
    };
    await expect(collectEvidence(faultyClient, {})).rejects.toThrow('synthetic collector failure');
    expect(interrupted).toBe(true);
    const state = await client.query('SHOW transaction_read_only');
    expect(state.rows[0].transaction_read_only).toBe('off');
    const heartbeat = await client.query('SELECT 1 AS ok');
    expect(heartbeat.rows[0].ok).toBe(1);
  });
});
