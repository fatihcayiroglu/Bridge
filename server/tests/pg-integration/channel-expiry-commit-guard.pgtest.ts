/**
 * P7 D2 — test-only, real-PostgreSQL commit-time message insert guard proof.
 *
 * No migration, application writer or shared public table is modified here.
 * Each run creates and drops a uniquely named schema. This is a design
 * experiment; it is NOT shipping expiry or solving issue #321.
 *
 * Key distinction: a deferred AFTER INSERT constraint trigger runs only for
 * inserted rows, including at COMMIT, while BEFORE INSERT also runs on rows
 * ultimately suppressed by ON CONFLICT DO NOTHING.
 */
import { Pool, type PoolClient } from 'pg';

const PG_TEST_URL = process.env.PG_TEST_URL;
const RUN = PG_TEST_URL ? describe : describe.skip;
const schemaName = 'p7_d2_commit_guard_' + process.pid + '_' + Date.now() + '_' +
  Math.random().toString(36).slice(2, 10);
const S = '"' + schemaName + '"';
const SQL_INSERT = 'INSERT INTO ' + S +
  '.messages (_id,"channelId","serverId","userId","ackId") VALUES ($1,$2,$3,$4,$5)';

RUN('P7 D2 deferred INSERT barrier — isolated real PostgreSQL', () => {
  const pool = new Pool({ connectionString: PG_TEST_URL, max: 5 });
  let schemaCreated = false;

  const query = (sql: string, params: unknown[] = []) => pool.query(sql, params);
  const put = (id: string, channelId: string, serverId = 'tenant-one') =>
    query(SQL_INSERT, [id, channelId, serverId, 'author-one', id]);

  async function rowCount(id: string): Promise<number> {
    const result = await query('SELECT COUNT(*)::int AS n FROM ' + S + '.messages WHERE _id=$1', [id]);
    return Number(result.rows[0].n);
  }

  beforeAll(async () => {
    await query('CREATE SCHEMA ' + S);
    schemaCreated = true;
    await query('CREATE TABLE ' + S + '.channels (' +
      '_id TEXT PRIMARY KEY, "serverId" TEXT NOT NULL, ' +
      '"expiresAt" BIGINT, "expiryVersion" BIGINT)');
    await query('CREATE TABLE ' + S + '.channel_expiry_tombstones (' +
      '"channelId" TEXT PRIMARY KEY, "serverId" TEXT NOT NULL)');
    await query('CREATE TABLE ' + S + '.messages (' +
      '_id TEXT PRIMARY KEY, "channelId" TEXT NOT NULL, ' +
      '"serverId" TEXT NOT NULL, "userId" TEXT NOT NULL, "ackId" TEXT, ' +
      'UNIQUE ("userId","ackId"))');

    // A transaction's COMMIT runs this constraint trigger after ordinary
    // INSERT operations. FOR SHARE serializes with the expiry worker's
    // channel UPDATE/DELETE (which must use a conflicting row lock).
    const functionSql = [
      'CREATE FUNCTION ' + S + '.guard_message_insert() RETURNS trigger',
      'LANGUAGE plpgsql AS $guard$',
      'DECLARE exp BIGINT; ver BIGINT;',
      'BEGIN',
      '  SELECT "expiresAt","expiryVersion" INTO exp,ver FROM ' + S + '.channels',
      '  WHERE _id=NEW."channelId" AND "serverId"=NEW."serverId" FOR SHARE;',
      "  IF NOT FOUND THEN RAISE EXCEPTION 'channel unavailable' USING ERRCODE='23514'; END IF;",
      "  IF ver IS NULL OR ver < 0 OR (exp IS NOT NULL AND (exp <= 0 OR ver = 0)) THEN",
      "    RAISE EXCEPTION 'channel unavailable' USING ERRCODE='23514';",
      '  END IF;',
      '  IF EXISTS (SELECT 1 FROM ' + S +
        '.channel_expiry_tombstones WHERE "channelId"=NEW."channelId") THEN',
      "    RAISE EXCEPTION 'channel unavailable' USING ERRCODE='23514';",
      '  END IF;',
      '  IF exp IS NOT NULL AND exp <= (EXTRACT(EPOCH FROM clock_timestamp())*1000)::BIGINT THEN',
      "    RAISE EXCEPTION 'channel unavailable' USING ERRCODE='23514';",
      '  END IF;',
      '  RETURN NEW;',
      'END $guard$;',
    ].join('\n');
    await query(functionSql);
    await query('CREATE CONSTRAINT TRIGGER channel_expiry_commit_barrier ' +
      'AFTER INSERT ON ' + S + '.messages DEFERRABLE INITIALLY DEFERRED ' +
      'FOR EACH ROW EXECUTE FUNCTION ' + S + '.guard_message_insert()');

    const later = Date.now() + 10 * 60_000;
    const earlier = Date.now() - 10 * 60_000;
    for (const [id, expiry, version] of [
      ['permanent', null, 0],
      ['active', later, 1],
      ['expired', earlier, 1],
      ['invalid', later, 0],
      ['tombstoned', later, 1],
      ['idempotent', later, 1],
      ['changed-during-write', later, 1],
      ['row-locked-by-worker', later, 1],
    ] as Array<[string, number | null, number]>) {
      await query('INSERT INTO ' + S + '.channels VALUES ($1,$2,$3,$4)',
        [id, 'tenant-one', expiry, version]);
    }
    await query('INSERT INTO ' + S + '.channel_expiry_tombstones VALUES ($1,$2)',
      ['tombstoned', 'different-tenant']);
  });

  afterAll(async () => {
    try {
      if (schemaCreated) await query('DROP SCHEMA ' + S + ' CASCADE');
    } finally {
      await pool.end();
    }
  });

  it('allows a permanent legacy channel and an active expiring channel', async () => {
    await put('permanent-insert', 'permanent');
    await put('active-insert', 'active');
    expect(await rowCount('permanent-insert')).toBe(1);
    expect(await rowCount('active-insert')).toBe(1);
  });

  it.each([
    ['missing channel', 'not-created', 'tenant-one'],
    ['wrong tenant', 'active', 'tenant-two'],
    ['expired channel', 'expired', 'tenant-one'],
    ['corrupt expiry version', 'invalid', 'tenant-one'],
    ['globally tombstoned even with wrong tombstone tenant', 'tombstoned', 'tenant-one'],
  ])('denies %s before durable COMMIT', async (_, channelId, tenant) => {
    const id = 'rejected-' + channelId + '-' + tenant;
    await expect(put(id, channelId, tenant)).rejects.toMatchObject({ code: '23514' });
    expect(await rowCount(id)).toBe(0);
  });

  it('rejects if the channel expires after INSERT but before COMMIT', async () => {
    const writer = await pool.connect();
    try {
      await writer.query('BEGIN');
      await writer.query(SQL_INSERT, ['late-commit', 'changed-during-write',
        'tenant-one', 'author-one', 'late-commit']);
      // No deferred guard has fired yet; an expiry update can proceed.
      await query('UPDATE ' + S + '.channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2',
        [Date.now() - 1000, 'changed-during-write']);
      await expect(writer.query('COMMIT')).rejects.toMatchObject({ code: '23514' });
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    expect(await rowCount('late-commit')).toBe(0);
  });

  it('conflicts with a concurrent expiry-worker FOR UPDATE lock', async () => {
    const worker: PoolClient = await pool.connect();
    const writer: PoolClient = await pool.connect();
    try {
      await worker.query('BEGIN');
      await worker.query('SELECT _id FROM ' + S + '.channels WHERE _id=$1 FOR UPDATE',
        ['row-locked-by-worker']);
      await writer.query('BEGIN');
      await writer.query("SET LOCAL lock_timeout = '250ms'");
      await writer.query(SQL_INSERT, ['lock-denied', 'row-locked-by-worker',
        'tenant-one', 'author-one', 'lock-denied']);
      // The deferred trigger's FOR SHARE must wait for worker's FOR UPDATE.
      await expect(writer.query('COMMIT')).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await worker.query('ROLLBACK').catch(() => undefined);
      writer.release();
      worker.release();
    }
    expect(await rowCount('lock-denied')).toBe(0);
  });

  it('does not reject a duplicate suppressed by ON CONFLICT DO NOTHING', async () => {
    await put('replayed', 'idempotent');
    await query('UPDATE ' + S + '.channels SET "expiresAt"=$1,"expiryVersion"=2 WHERE _id=$2',
      [Date.now() - 1000, 'idempotent']);
    const duplicate = await query(SQL_INSERT +
      ' ON CONFLICT (_id) DO NOTHING RETURNING _id',
      ['replayed', 'idempotent', 'tenant-one', 'author-one', 'replayed']);
    expect(duplicate.rowCount).toBe(0);
    expect(await rowCount('replayed')).toBe(1);
    // This proves only that a duplicate created no new row. Caller must
    // separately authorize access to the prior row; no replayed ACK policy.
  });
});
