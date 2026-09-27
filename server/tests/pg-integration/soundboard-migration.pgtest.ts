// Real PostgreSQL proof for migration 059. The default unit suite verifies
// source ownership; this suite verifies PostgreSQL's actual NOT VALID,
// validation, and narrow PL/pgSQL exception semantics.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;
const migrationSql = fs.readFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations_pg', '059_soundboard_library.sql'),
  'utf8',
);
const rollbackSql = fs.readFileSync(
  path.join(__dirname, '..', '..', 'db', 'migrations_pg', 'rollback', '059_soundboard_library.down.sql'),
  'utf8',
);
const CONSTRAINTS = [
  'soundboard_name_length',
  'soundboard_emoji_length',
  'soundboard_category_length',
  'soundboard_duration_bounds',
  'soundboard_file_size_bounds',
  'fk_soundboard_server',
] as const;

type PgFailure = Error & { code?: string };

RUN('real PostgreSQL — soundboard migration 059', () => {
  let client: Client;
  const schemas: string[] = [];

  beforeAll(async () => {
    client = new Client({ connectionString: PG_URL });
    await client.connect();
  });

  afterAll(async () => {
    if (!client) return;
    await client.query('SET search_path TO public').catch(() => undefined);
    for (const schema of schemas) {
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  });

  async function createLegacySchema(options: { metadata: boolean }): Promise<string> {
    const schema = `sb059_${crypto.randomBytes(6).toString('hex')}`;
    schemas.push(schema);
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`
      CREATE TABLE users (_id TEXT PRIMARY KEY);
      CREATE TABLE servers (_id TEXT PRIMARY KEY);
      CREATE TABLE soundboard (
        _id TEXT PRIMARY KEY,
        "serverId" TEXT NOT NULL,
        name TEXT NOT NULL,
        emoji TEXT NOT NULL DEFAULT '🔊',
        ${options.metadata ? `category TEXT NOT NULL DEFAULT 'Server',
        "durationSeconds" DOUBLE PRECISION,
        "mimeType" TEXT,
        "fileSize" BIGINT,
        "updatedAt" BIGINT,` : ''}
        url TEXT NOT NULL,
        "uploadedBy" TEXT NOT NULL,
        "createdAt" BIGINT NOT NULL
      );
      INSERT INTO users (_id) VALUES ('u1');
      INSERT INTO servers (_id) VALUES ('s1');
    `);
    return schema;
  }

  async function constraintState(): Promise<Array<{ conname: string; convalidated: boolean; definition: string }>> {
    const result = await client.query<{ conname: string; convalidated: boolean; definition: string }>(
      `SELECT conname, convalidated, pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'soundboard'::regclass
          AND conname = ANY($1::text[])
        ORDER BY conname`,
      [CONSTRAINTS],
    );
    return result.rows;
  }

  it('validates a clean upgrade and clean rollback/re-up with the exact fresh duration CHECK', async () => {
    await createLegacySchema({ metadata: false });
    await client.query(
      `INSERT INTO soundboard (_id, "serverId", name, emoji, url, "uploadedBy", "createdAt")
       VALUES ('clean', 's1', 'Clean', '🔊', '/clean.wav', 'u1', 1)`,
    );

    await client.query(migrationSql);
    let constraints = await constraintState();
    expect(constraints.map(row => row.conname)).toEqual([...CONSTRAINTS].sort());
    expect(constraints.every(row => row.convalidated)).toBe(true);

    await client.query(`
      CREATE TABLE fresh_duration_contract (
        "durationSeconds" DOUBLE PRECISION
          CONSTRAINT fresh_duration_bounds CHECK ("durationSeconds" > 0 AND "durationSeconds" <= 5)
      )
    `);
    const fresh = await client.query<{ definition: string }>(
      `SELECT pg_get_constraintdef(oid) AS definition
         FROM pg_constraint
        WHERE conrelid = 'fresh_duration_contract'::regclass
          AND conname = 'fresh_duration_bounds'`,
    );
    const migratedDuration = constraints.find(row => row.conname === 'soundboard_duration_bounds');
    expect(migratedDuration?.definition).toBe(fresh.rows[0]?.definition);

    await client.query(rollbackSql);
    await client.query(migrationSql);
    constraints = await constraintState();
    expect(constraints.every(row => row.convalidated)).toBe(true);
    expect(constraints.find(row => row.conname === 'soundboard_duration_bounds')?.definition)
      .toBe(fresh.rows[0]?.definition);
  });

  it('keeps dirty legacy rows available but enforces every new write', async () => {
    await createLegacySchema({ metadata: true });
    await client.query(
      `INSERT INTO soundboard
         (_id, "serverId", name, emoji, category, url, "uploadedBy",
          "durationSeconds", "fileSize", "createdAt")
       VALUES ('dirty', 'missing-server', repeat('n', 33), '', repeat('c', 33),
               '/dirty.wav', 'u1', 6, 5242881, 1)`,
    );

    await expect(client.query(migrationSql)).resolves.toBeDefined();
    const constraints = await constraintState();
    expect(constraints.map(row => row.conname)).toEqual([...CONSTRAINTS].sort());
    expect(constraints.every(row => row.convalidated === false)).toBe(true);

    await expect(client.query(
      `INSERT INTO soundboard
         (_id, "serverId", name, emoji, category, url, "uploadedBy",
          "durationSeconds", "fileSize", "createdAt")
       VALUES ('new-invalid', 's1', 'New', '🔊', 'Server', '/new.wav', 'u1', 6, 10, 2)`,
    )).rejects.toMatchObject({ code: '23514' });
    await expect(client.query(
      `INSERT INTO soundboard
         (_id, "serverId", name, emoji, category, url, "uploadedBy",
          "durationSeconds", "fileSize", "createdAt")
       VALUES ('new-valid', 's1', 'New', '🔊', 'Server', '/new.wav', 'u1', 1, 10, 2)`,
    )).resolves.toBeDefined();
  });

  it('does not swallow a non-data validation error', async () => {
    await createLegacySchema({ metadata: false });
    // A same-named UNIQUE constraint makes VALIDATE CONSTRAINT fail with a
    // structural wrong-object-type error. Only check_violation/FK violation
    // may be tolerated; this error must escape the migration.
    await client.query('ALTER TABLE soundboard ADD CONSTRAINT soundboard_name_length UNIQUE (name)');

    let failure: PgFailure | undefined;
    try {
      await client.query(migrationSql);
    } catch (error) {
      failure = error as PgFailure;
    }
    expect(failure).toBeDefined();
    expect(failure?.code).not.toBe('23514');
    // SQLSTATE is the version-stable contract; the MESSAGE TEXT IS NOT.
    // PostgreSQL 16 wrote `constraint "X" of relation "Y" is not a foreign key
    // or check constraint`; 17/18 write `cannot validate constraint "X" of
    // relation "Y"` and move the reason into DETAIL. Pinning the 16 wording
    // made this suite fail on the version docker-compose actually deploys,
    // while proving nothing extra: 42809 (wrong_object_type) is precisely the
    // "this is not a validatable data constraint" signal being asserted.
    expect(failure?.code).toBe('42809');
    expect(failure?.message).toMatch(/soundboard_name_length/);
  });
});
