// server/tests/pg-integration/server-ai-optout.pgtest.ts
//
// P6 — per-server AI opt-out on a real PostgreSQL (migration 078).
//
//   · the column exists, is NOT NULL and defaults to TRUE (existing servers
//     keep their behaviour; the owner opts out);
//   · the value written through the repository is what a NEW connection reads
//     back — the setting survives a restart, it is not process state;
//   · the policy module reads it from the database on every call.
// Runs only with PG_TEST_URL; removes its own rows.

import { Pool } from 'pg';
import { Servers } from '../../db/repositories';
import { serverAllowsAi, serversAllowingAi } from '../../lib/aiServerPolicy';

const db = require('../../db/loader').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;
const P = 'pgt-aioptout';

RUN('real PostgreSQL — servers."aiEnabled" (P6)', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;
  const cleanup = () => q(`DELETE FROM servers WHERE _id LIKE $1`, [`${P}-%`]);

  beforeAll(cleanup);
  afterAll(cleanup);

  it('the column is NOT NULL with default TRUE', async () => {
    const [row] = await q(
      `SELECT is_nullable, column_default, data_type FROM information_schema.columns
        WHERE table_name = 'servers' AND column_name = 'aiEnabled'`,
    );
    expect(row).toEqual({ is_nullable: 'NO', column_default: 'true', data_type: 'boolean' });
  });

  it('a server inserted without the field (as every pre-078 server was) allows AI', async () => {
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'S', 'o', 1)`, [`${P}-old`]);
    const [row] = await q(`SELECT "aiEnabled" FROM servers WHERE _id = $1`, [`${P}-old`]);
    expect(row.aiEnabled).toBe(true);
    expect(await serverAllowsAi(`${P}-old`)).toBe(true);
  });

  it('the opt-out written through the repository survives a fresh connection (restart)', async () => {
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'S', 'o', 1)`, [`${P}-off`]);
    await Servers.update(`${P}-off`, { aiEnabled: false });

    // A brand-new pool = what a restarted process sees.
    const fresh = new Pool({ connectionString: PG_URL, max: 1 });
    try {
      const { rows } = await fresh.query(`SELECT "aiEnabled" FROM servers WHERE _id = $1`, [`${P}-off`]);
      expect(rows[0].aiEnabled).toBe(false);
    } finally {
      await fresh.end();
    }
    expect(await serverAllowsAi(`${P}-off`)).toBe(false);
  });

  it('re-enabling is read on the very next call; neighbours are independent', async () => {
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'S', 'o', 1), ($2, 'S', 'o', 1)`, [`${P}-a`, `${P}-b`]);
    await Servers.update(`${P}-a`, { aiEnabled: false });
    expect([...await serversAllowingAi([`${P}-a`, `${P}-b`])]).toEqual([`${P}-b`]);
    await Servers.update(`${P}-a`, { aiEnabled: true });
    expect(await serverAllowsAi(`${P}-a`)).toBe(true);
  });

  it('CONTROL: the database refuses NULL — "unknown" can never mean "allowed"', async () => {
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'S', 'o', 1)`, [`${P}-null`]);
    await expect(q(`UPDATE servers SET "aiEnabled" = NULL WHERE _id = $1`, [`${P}-null`])).rejects.toThrow(/null/i);
  });

  it('a missing server is treated as "no AI" (fail closed)', async () => {
    expect(await serverAllowsAi(`${P}-does-not-exist`)).toBe(false);
  });
});
