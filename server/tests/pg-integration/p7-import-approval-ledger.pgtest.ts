// Real PostgreSQL P7 C4 approval ledger evidence. No mock can prove row-lock
// contention, transaction rollback or durable one-time use across connections.
// npm run test:pg REQUIRES PG_TEST_URL; never silently skip this suite.
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import {
  claimPortableImportApproval, stagePortableImportApproval,
  PortableImportApprovalError, type PortableApprovalBinding,
} from '../../lib/portableImportApprovalLedger';

const URL = process.env.PG_TEST_URL;
if (!URL) throw new Error('PG_TEST_URL required for P7 approval ledger real-DB evidence');
const schema = 'p7consent_' + randomBytes(8).toString('hex');
const quoted = '"' + schema + '"';
const b: PortableApprovalBinding = {
  targetServerId: 'destination', ownerId: 'owner',
  reviewFingerprint: 'a'.repeat(64), targetTopologyDigest: 'b'.repeat(64),
  targetGrantDigest: 'f'.repeat(64),
  sourceOrigin: 'https://source.example', sourceServerId: 'source',
  sourceSnapshotId: 'source-snapshot-token-1234567',
  sourceKeyFingerprint: 'c'.repeat(64),
  structureDigest: 'd'.repeat(64), permissionsDigest: 'e'.repeat(64),
};
const expires = () => new Date(Date.now() + 70_000).toISOString();
let admin: Pool;
let pool: Pool;
let second: Pool;

beforeAll(async () => {
  admin = new Pool({ connectionString: URL, max: 1 });
  await admin.query('CREATE SCHEMA ' + quoted);
  pool = new Pool({ connectionString: URL, max: 3, options: '-c search_path=' + schema });
  second = new Pool({ connectionString: URL, max: 2, options: '-c search_path=' + schema });
  await pool.query('CREATE TABLE servers (_id TEXT PRIMARY KEY, "ownerId" TEXT NOT NULL)');
  await pool.query('INSERT INTO servers (_id, "ownerId") VALUES ($1,$2)', [b.targetServerId, b.ownerId]);
  // Exercise exactly the production migration in a private schema.
  const sql = readFileSync(join(__dirname, '../../db/migrations_pg/081_portable_import_approval_ledger.sql'), 'utf8');
  await pool.query(sql);
  const grantMigration = readFileSync(join(__dirname, '../../db/migrations_pg/082_portable_import_approval_grant_binding.sql'), 'utf8');
  await pool.query(grantMigration);
}, 60_000);

afterAll(async () => {
  if (pool) await pool.end();
  if (second) await second.end();
  if (admin) {
    try { await admin.query('DROP SCHEMA ' + quoted + ' CASCADE'); }
    finally { await admin.end(); }
  }
}, 60_000);

async function stage() {
  return stagePortableImportApproval({
    pool, binding: b, sourceAttestationExpiresAt: expires(),
  });
}
async function claimOn(txPool: Pool, token: string, binding: PortableApprovalBinding = b) {
  const client = await txPool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
    await claimPortableImportApproval(client, token, binding);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
async function consumedCount(token: string): Promise<number> {
  const digest = createHash('sha256').update('bridge-portable-import-approval-v1\n')
    .update(token).digest('hex');
  const res = await second.query(
    'SELECT COUNT(*)::int AS n FROM portable_import_approvals WHERE token_hash=$1 AND consumed_at IS NOT NULL',
    [digest],
  );
  return res.rows[0].n as number;
}

describe('P7 C4 approval ledger actual PG session/rollback behaviour', () => {
  it('stores only token hash, DB-caps expiry, survives a new client, refuses committed replay', async () => {
    const issued = await stage();
    expect(issued).toMatchObject({ importSupported: false, writesPerformed: false });
    const { rows } = await second.query('SELECT * FROM portable_import_approvals ORDER BY created_at DESC LIMIT 1');
    const row = rows[0];
    expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.token_hash).not.toBe(issued.approvalToken);
    expect(row.source_origin).toBe(b.sourceOrigin);
    expect(row.source_key_fingerprint).toBe(b.sourceKeyFingerprint);
    expect(row.review_fingerprint).toBe(b.reviewFingerprint);
    expect(row.target_grant_digest).toBe(b.targetGrantDigest);
    expect(row.expires_at).toBeInstanceOf(Date);
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBeLessThanOrEqual(120_000);
    await claimOn(second, issued.approvalToken);
    expect(await consumedCount(issued.approvalToken)).toBe(1);
    await expect(claimOn(pool, issued.approvalToken)).rejects.toBeInstanceOf(PortableImportApprovalError);
    expect(await consumedCount(issued.approvalToken)).toBe(1);
  });

  it('invalidates legacy NULL grant evidence and rejects invalid persisted digests', async () => {
    const issued = await stage();
    const digest = createHash('sha256').update('bridge-portable-import-approval-v1\\n')
      .update(issued.approvalToken).digest('hex');
    await expect(pool.query(
      'UPDATE portable_import_approvals SET target_grant_digest=$1 WHERE token_hash=$2',
      ['not-a-hex-digest', digest],
    )).rejects.toThrow();
    await pool.query(
      'UPDATE portable_import_approvals SET target_grant_digest=NULL WHERE token_hash=$1',
      [digest],
    );
    await expect(claimOn(second, issued.approvalToken))
      .rejects.toBeInstanceOf(PortableImportApprovalError);
    expect(await consumedCount(issued.approvalToken)).toBe(0);
  });

  it('refuses mismatched target digest, revoked ownership and expired consent', async () => {
    const issued = await stage();
    await expect(claimOn(second, issued.approvalToken,
      { ...b, targetTopologyDigest: 'f'.repeat(64) }))
      .rejects.toBeInstanceOf(PortableImportApprovalError);
    await expect(claimOn(second, issued.approvalToken,
      { ...b, targetGrantDigest: '0'.repeat(64) }))
      .rejects.toBeInstanceOf(PortableImportApprovalError);
    await pool.query('UPDATE servers SET "ownerId"=$1 WHERE _id=$2', ['new-owner', b.targetServerId]);
    await expect(claimOn(second, issued.approvalToken))
      .rejects.toBeInstanceOf(PortableImportApprovalError);
    await pool.query('UPDATE servers SET "ownerId"=$1 WHERE _id=$2', [b.ownerId, b.targetServerId]);
    // Move expiry to a genuine already-past timestamp, while retaining
    // the production table's created_at < expires_at check.
    const hash = createHash('sha256').update('bridge-portable-import-approval-v1\n')
      .update(issued.approvalToken).digest('hex');
    await pool.query(
      "UPDATE portable_import_approvals SET expires_at=created_at+INTERVAL '1 microsecond' WHERE token_hash=$1",
      [hash]);
    await expect(claimOn(second, issued.approvalToken))
      .rejects.toBeInstanceOf(PortableImportApprovalError);
    expect(await consumedCount(issued.approvalToken)).toBe(0);
  });

  it('rolls back claim with the transaction, then accepts at most one eventual COMMIT', async () => {
    const issued = await stage();
    const c = await pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await claimPortableImportApproval(c, issued.approvalToken, b);
      await c.query('ROLLBACK');
    } finally { c.release(); }
    expect(await consumedCount(issued.approvalToken)).toBe(0);
    await claimOn(second, issued.approvalToken);
    expect(await consumedCount(issued.approvalToken)).toBe(1);
    await expect(claimOn(pool, issued.approvalToken)).rejects.toBeInstanceOf(PortableImportApprovalError);
  });

  it('serializes concurrent independent-client claims with only one winner', async () => {
    const issued = await stage();
    const c1 = await pool.connect();
    const c2 = await second.connect();
    try {
      await c1.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await c2.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await claimPortableImportApproval(c1, issued.approvalToken, b);
      const pending = claimPortableImportApproval(c2, issued.approvalToken, b);
      await c1.query('COMMIT');
      await expect(pending).rejects.toBeInstanceOf(PortableImportApprovalError);
      await c2.query('ROLLBACK');
    } finally { c1.release(); c2.release(); }
    expect(await consumedCount(issued.approvalToken)).toBe(1);
  });

  it('never stages for missing/changed owner, no partial rows remain', async () => {
    const before = (await pool.query('SELECT COUNT(*)::int AS n FROM portable_import_approvals')).rows[0].n;
    await expect(stagePortableImportApproval({
      pool, binding: { ...b, ownerId: 'not-owner' }, sourceAttestationExpiresAt: expires(),
    })).rejects.toBeInstanceOf(PortableImportApprovalError);
    const after = (await pool.query('SELECT COUNT(*)::int AS n FROM portable_import_approvals')).rows[0].n;
    expect(after).toBe(before);
  });
});
