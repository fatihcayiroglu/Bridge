// Real PostgreSQL, one physical session, no mocks or silent skip.
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { mintStepUpGrant } from '../../lib/stepUp';
import { LockedPortableOwnerStepUpError, requireLockedPortableOwnerStepUp } from '../../lib/portableLockedOwnerStepUp';

const URL = process.env.PG_TEST_URL;
if (!URL) throw new Error('PG_TEST_URL required for locked owner step-up proof');
const schema = 'p7stepup_' + randomBytes(8).toString('hex');
const quoted = '"' + schema + '"';
const NOW = Date.parse('2026-10-13T15:00:00.000Z');
const OWNER = 'target-owner';
const originalSecret = process.env.STEP_UP_SECRET;
let admin: Pool, primary: Pool, secondary: Pool;
function grant(method: 'password' | 'totp' = 'password', at = NOW) {
  return mintStepUpGrant({ _id: OWNER, tokenVersion: 4 }, method, 'account-security', at).token;
}
beforeAll(async () => {
  process.env.STEP_UP_SECRET = 'p7-test-only-in-transaction-secret';
  admin = new Pool({ connectionString: URL, max: 1 });
  await admin.query('CREATE SCHEMA ' + quoted);
  primary = new Pool({ connectionString: URL, max: 2, options: '-c search_path=' + schema });
  secondary = new Pool({ connectionString: URL, max: 2, options: '-c search_path=' + schema });
  await primary.query('CREATE TABLE users (_id TEXT PRIMARY KEY, "tokenVersion" INTEGER NOT NULL, "twoFactorEnabled" BOOLEAN NOT NULL)');
  await primary.query('INSERT INTO users VALUES ($1,$2,$3)', [OWNER, 4, false]);
}, 60_000);
afterAll(async () => {
  if (primary) await primary.end();
  if (secondary) await secondary.end();
  if (admin) {
    try { await admin.query('DROP SCHEMA ' + quoted + ' CASCADE'); }
    finally { await admin.end(); }
  }
  if (originalSecret === undefined) delete process.env.STEP_UP_SECRET;
  else process.env.STEP_UP_SECRET = originalSecret;
}, 60_000);
describe('live P7 locked owner credential proof in serializable PostgreSQL transaction', () => {
  it('reads and locks current version and second-factor state on the same client', async () => {
    const client = await primary.connect(), rival = await secondary.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      const result = await requireLockedPortableOwnerStepUp({
        client, ownerId: OWNER, stepUpGrant: grant(), now: NOW,
      });
      expect(result).toMatchObject({ stepUpVerified: true, consentVerified: false,
        tokenIssued: false, importSupported: false, writesPerformed: false });
      await rival.query('BEGIN');
      await rival.query("SET LOCAL lock_timeout='150ms'");
      await expect(rival.query('UPDATE users SET "tokenVersion"=5 WHERE _id=$1', [OWNER]))
        .rejects.toThrow();
      await rival.query('ROLLBACK');
      await client.query('COMMIT');
    } finally { client.release(); rival.release(); }
  });
  it('rejects stale tokenVersion, 2FA downgrade and unsuitable isolation', async () => {
    const signed = grant();
    await secondary.query('UPDATE users SET "tokenVersion"=5 WHERE _id=$1', [OWNER]);
    let client = await primary.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(requireLockedPortableOwnerStepUp({
        client, ownerId: OWNER, stepUpGrant: signed, now: NOW,
      })).rejects.toBeInstanceOf(LockedPortableOwnerStepUpError);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    await secondary.query('UPDATE users SET "tokenVersion"=4, "twoFactorEnabled"=TRUE WHERE _id=$1', [OWNER]);
    client = await primary.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await expect(requireLockedPortableOwnerStepUp({
        client, ownerId: OWNER, stepUpGrant: grant('password'), now: NOW,
      })).rejects.toBeInstanceOf(LockedPortableOwnerStepUpError);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    await secondary.query('UPDATE users SET "twoFactorEnabled"=FALSE WHERE _id=$1', [OWNER]);
    client = await primary.connect();
    try {
      await client.query('BEGIN');
      await expect(requireLockedPortableOwnerStepUp({
        client, ownerId: OWNER, stepUpGrant: grant(), now: NOW,
      })).rejects.toBeInstanceOf(LockedPortableOwnerStepUpError);
      await client.query('ROLLBACK');
    } finally { client.release(); }
  });
});
