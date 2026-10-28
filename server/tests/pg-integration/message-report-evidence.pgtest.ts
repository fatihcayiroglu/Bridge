// P7 B5 migration 085 (#336): REAL PostgreSQL proof, never a mock.
// Run by the test:pg job against PG_TEST_URL only. Every statement runs in one
// transaction that is rolled back.
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;
const dir = path.resolve(__dirname, '../../db/migrations_pg');
const up = fs.readFileSync(path.join(dir, '085_message_report_evidence.sql'), 'utf8');
const down = fs.readFileSync(path.join(dir, 'rollback/085_message_report_evidence.down.sql'), 'utf8');
const COLUMNS = ['evidenceCapturedAt', 'evidenceAuthorId', 'evidenceAuthorName', 'evidenceText', 'evidenceTextTruncated',
  'evidenceCreatedAt', 'evidenceEditedAt', 'evidenceFileName', 'evidenceFileType'];

async function inDisposableTransaction(body: (client: Client) => Promise<void>): Promise<void> {
  const client = new Client({ connectionString: PG_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    try { await body(client); } finally { await client.query('ROLLBACK'); }
  } finally { await client.end(); }
}

async function fixture(client: Client, id: string, evidence: Record<string, unknown> = {}): Promise<void> {
  await client.query(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1,$1,$1,$1,1) ON CONFLICT DO NOTHING`, [`${id}-u`]);
  await client.query(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1,$1,$2,1) ON CONFLICT DO NOTHING`, [`${id}-s`, `${id}-u`]);
  await client.query(`INSERT INTO channels (_id, "serverId", name, "createdAt") VALUES ($1,$2,$1,1) ON CONFLICT DO NOTHING`, [`${id}-c`, `${id}-s`]);
  await client.query(
    `INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
     VALUES ($1,$2,$3,$4,$4,$4,'x',1) ON CONFLICT DO NOTHING`, [`${id}-m`, `${id}-c`, `${id}-s`, `${id}-u`]);
  const cols = ['_id', '"serverId"', '"channelId"', '"messageId"', '"reporterId"', 'reason', '"createdAt"', ...Object.keys(evidence).map(k => `"${k}"`)];
  const vals = [id, `${id}-s`, `${id}-c`, `${id}-m`, `${id}-u`, 'spam', 1, ...Object.values(evidence)];
  await client.query(`INSERT INTO message_reports (${cols.join(',')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')})`, vals);
}

RUN('P7 B5 migration 085 — real PostgreSQL evidence snapshot columns', () => {
  it('adds nullable columns; a report without a snapshot keeps NULLs', async () => {
    await inDisposableTransaction(async client => {
      const cols = await client.query(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema='public' AND table_name='message_reports' AND column_name LIKE 'evidence%'`);
      expect(cols.rows.map(r => r.column_name).sort()).toEqual([...COLUMNS].sort());
      expect(cols.rows.every(r => r.is_nullable === 'YES')).toBe(true);
      await fixture(client, 'pgt-ev-legacy');
      const row = (await client.query(`SELECT * FROM message_reports WHERE _id='pgt-ev-legacy'`)).rows[0];
      for (const c of COLUMNS) expect(row[c]).toBeNull();
    });
  });

  it('refuses over-long evidence at the database, not only in the application', async () => {
    await inDisposableTransaction(async client => {
      await client.query('SAVEPOINT bad');
      await expect(fixture(client, 'pgt-ev-long', { evidenceText: 'a'.repeat(4001) })).rejects.toThrow(/message_reports_evidence_bounds_check/);
      await client.query('ROLLBACK TO SAVEPOINT bad');
      await fixture(client, 'pgt-ev-edge', { evidenceCapturedAt: 5, evidenceText: 'a'.repeat(4000) });
    });
  });

  it('survives a user-row delete cascade only as far as the existing foreign keys say (no new FK on the author)', async () => {
    await inDisposableTransaction(async client => {
      const fks = await client.query(
        `SELECT a.attname FROM pg_constraint c JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum = ANY(c.conkey)
          WHERE c.conrelid='message_reports'::regclass AND c.contype='f'`);
      expect(fks.rows.map(r => r.attname).some(n => String(n).startsWith('evidence'))).toBe(false);
    });
  });

  it('rolls back and re-applies cleanly while no snapshot exists', async () => {
    await inDisposableTransaction(async client => {
      await client.query(down);
      const gone = await client.query(
        `SELECT COUNT(*)::integer AS n FROM information_schema.columns WHERE table_name='message_reports' AND column_name LIKE 'evidence%'`);
      expect(gone.rows[0].n).toBe(0);
      await client.query(up);
      await client.query(up); // idempotent
      const back = await client.query(
        `SELECT COUNT(*)::integer AS n FROM information_schema.columns WHERE table_name='message_reports' AND column_name LIKE 'evidence%'`);
      expect(back.rows[0].n).toBe(COLUMNS.length);
    });
  });

  it('refuses to roll back once a snapshot exists, and keeps it', async () => {
    await inDisposableTransaction(async client => {
      await fixture(client, 'pgt-ev-kept', { evidenceCapturedAt: 9, evidenceText: 'reported text' });
      await client.query('SAVEPOINT refuse');
      await expect(client.query(down)).rejects.toThrow(/evidence snapshots exist/i);
      await client.query('ROLLBACK TO SAVEPOINT refuse');
      const kept = await client.query(`SELECT "evidenceText" FROM message_reports WHERE _id='pgt-ev-kept'`);
      expect(kept.rows[0].evidenceText).toBe('reported text');
    });
  });
});
