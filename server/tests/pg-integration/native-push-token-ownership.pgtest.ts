// server/tests/pg-integration/native-push-token-ownership.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// REAL PostgreSQL: A DEVICE TOKEN BELONGS TO THE ACCOUNT THAT REGISTERED IT LAST (P4-04)
// ════════════════════════════════════════════════════════════════════════════
// `native_push_tokens.token` is UNIQUE. Before P4 the repository keyed rows by
// `npt_<userId>_<platform>`: when a second account signed in on the same phone its
// registration hit the UNIQUE constraint and FAILED, and the first account's row stayed
// — the first account's DMs/mentions kept arriving on a phone now used by someone else.
// A mock cannot show this: only PostgreSQL enforces the constraint.

import { Notifications } from '../../db/repositories';

const db = require('../../db/loader').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const P = 'pgt-npt';
const A = `${P}-a`;
const B = `${P}-b`;
const TOKEN = `${P}-device-token`;

RUN('real PostgreSQL — native push token ownership', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;
  const cleanup = async () => {
    await q(`DELETE FROM native_push_tokens WHERE "userId" LIKE $1 OR token LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE _id LIKE $1`, [`${P}-%`]);
  };
  const owners = async (token: string) => (await q(`SELECT "userId" FROM native_push_tokens WHERE token = $1`, [token])).map((r: { userId: string }) => r.userId);

  beforeAll(async () => {
    await cleanup();
    for (const id of [A, B]) {
      await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1, $1, $1, 'x', 1)`, [id]);
    }
  });
  afterAll(async () => { await cleanup(); });

  it('a second account registering the same device token takes it over (no constraint error)', async () => {
    await Notifications.upsertNativeToken(A, 'android', TOKEN);
    expect(await owners(TOKEN)).toEqual([A]);

    await expect(Notifications.upsertNativeToken(B, 'android', TOKEN)).resolves.toBeDefined();
    expect(await owners(TOKEN)).toEqual([B]);
    expect(await q(`SELECT 1 FROM native_push_tokens WHERE "userId" = $1`, [A])).toHaveLength(0);
  });

  it('an account keeps several installations and re-registration is idempotent', async () => {
    await Notifications.upsertNativeToken(A, 'android', `${P}-phone`);
    await Notifications.upsertNativeToken(A, 'android', `${P}-tablet`);
    await Notifications.upsertNativeToken(A, 'android', `${P}-phone`);
    const rows = await q(`SELECT token FROM native_push_tokens WHERE "userId" = $1 ORDER BY token`, [A]);
    expect(rows.map((r: { token: string }) => r.token)).toEqual([`${P}-phone`, `${P}-tablet`]);
  });

  it('removeAllPushTargetsForUser clears every installation of that account only', async () => {
    const removed = await Notifications.removeAllPushTargetsForUser(A);
    expect(removed.native).toBe(2);
    expect(await q(`SELECT 1 FROM native_push_tokens WHERE "userId" = $1`, [A])).toHaveLength(0);
    expect(await owners(TOKEN)).toEqual([B]);
  });
});
