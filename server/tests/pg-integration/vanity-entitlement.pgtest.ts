// server/tests/pg-integration/vanity-entitlement.pgtest.ts
//
// ════════════════════════════════════════════════════════════════════════════
// REAL PostgreSQL: A VANITY URL IS ONLY CLAIMED WITH A LIVE LEVEL-3 BOOST
// ════════════════════════════════════════════════════════════════════════════
// `Boosts.mutateVanityAtomic` decides entitlement INSIDE one UPDATE: owner,
// at least 14 active, unexpired boosts from members who are not banned, and
// no other server holding the slug in any letter case. Its unit tests run
// against a mocked pool, so none of that SQL had ever executed. Proven here
// against PostgreSQL itself, including two servers racing for one slug.

import { Boosts } from '../../db/repositories';

const db = require('../../db/loader').default;

const PG_URL = process.env.PG_TEST_URL;
const RUN = PG_URL ? describe : describe.skip;

const P = 'pgt-vanity';
const A = `${P}-srv-a`;
const B = `${P}-srv-b`;
const OWNER_A = `${P}-owner-a`;
const OWNER_B = `${P}-owner-b`;
const NEEDED = 14;

RUN('real PostgreSQL — vanity URL entitlement is decided by the database', () => {
  const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;
  const cleanup = async () => {
    await q(`DELETE FROM server_boosts WHERE "serverId" LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM members WHERE "serverId" LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM servers WHERE _id LIKE $1`, [`${P}-%`]);
    await q(`DELETE FROM users WHERE _id LIKE $1`, [`${P}-%`]);
  };
  const vanityOf = async (sid: string) => (await q(`SELECT "vanityUrl" FROM servers WHERE _id=$1`, [sid]))[0]?.vanityUrl ?? null;

  /** `live` boosters who are members, plus optional expired/banned/departed extras. */
  async function boost(sid: string, live: number, extra: { live?: number; expired?: number; banned?: number; notMember?: number } = {}) {
    let n = 0;
    const add = async (kind: 'live' | 'expired' | 'banned' | 'notMember') => {
      const uid = `${P}-${sid.slice(-1)}-u${++n}`;
      await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1, $1, $1, 'x', 1)`, [uid]);
      if (kind !== 'notMember') {
        await q(`INSERT INTO members ("userId", "serverId", roles, "joinedAt", banned) VALUES ($1, $2, '[]', 1, $3)`,
          [uid, sid, kind === 'banned']);
      }
      await q(`INSERT INTO server_boosts ("serverId", "userId", active, "expiresAt") VALUES ($1, $2, TRUE, $3)`,
        [sid, uid, kind === 'expired' ? Date.now() - 60_000 : Date.now() + 86_400_000]);
    };
    for (let i = 0; i < live; i++) await add('live');
    for (let i = 0; i < (extra.expired ?? 0); i++) await add('expired');
    for (let i = 0; i < (extra.banned ?? 0); i++) await add('banned');
    for (let i = 0; i < (extra.notMember ?? 0); i++) await add('notMember');
  }

  beforeEach(async () => {
    await cleanup();
    for (const id of [OWNER_A, OWNER_B]) {
      await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt") VALUES ($1, $1, $1, 'x', 1)`, [id]);
    }
    await q(`INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1, 'A', $2, 1), ($3, 'B', $4, 1)`,
      [A, OWNER_A, B, OWNER_B]);
  });
  afterAll(async () => { await cleanup(); });

  it('the owner of a server with 14 live boosts claims the slug', async () => {
    await boost(A, NEEDED);
    await expect(Boosts.mutateVanityAtomic(A, OWNER_A, 'pgt-vanity-one')).resolves.toBe('ok');
    expect(await vanityOf(A)).toBe('pgt-vanity-one');
  });

  it.each([
    ['13 live boosts', { live: NEEDED - 1 }],
    ['13 live boosts plus one expired', { live: NEEDED - 1, expired: 1 }],
    ['13 live boosts plus one from a banned member', { live: NEEDED - 1, banned: 1 }],
    ['13 live boosts plus one from someone who left', { live: NEEDED - 1, notMember: 1 }],
  ])('%s is not level 3: refused, nothing written', async (_name, shape) => {
    await boost(A, shape.live, shape);
    await expect(Boosts.mutateVanityAtomic(A, OWNER_A, 'pgt-vanity-two')).resolves.toBe('boost_required');
    expect(await vanityOf(A)).toBeNull();
  });

  it('someone who does not own the server cannot set or clear its slug', async () => {
    await boost(A, NEEDED);
    await expect(Boosts.mutateVanityAtomic(A, OWNER_B, 'pgt-vanity-three')).resolves.toBe('forbidden');
    await q(`UPDATE servers SET "vanityUrl"='pgt-vanity-kept' WHERE _id=$1`, [A]);
    await expect(Boosts.mutateVanityAtomic(A, OWNER_B, null)).resolves.toBe('forbidden');
    expect(await vanityOf(A)).toBe('pgt-vanity-kept');
  });

  it('a slug another server holds in any letter case is a conflict', async () => {
    await boost(A, NEEDED);
    await q(`UPDATE servers SET "vanityUrl"='PGT-Vanity-Taken' WHERE _id=$1`, [B]);
    await expect(Boosts.mutateVanityAtomic(A, OWNER_A, 'pgt-vanity-taken')).resolves.toBe('conflict');
    expect(await vanityOf(A)).toBeNull();
  });

  it('the owner can clear a stale slug after the boosts lapsed', async () => {
    await q(`UPDATE servers SET "vanityUrl"='pgt-vanity-stale' WHERE _id=$1`, [A]);
    await expect(Boosts.mutateVanityAtomic(A, OWNER_A, null)).resolves.toBe('ok');
    expect(await vanityOf(A)).toBeNull();
  });

  it('an unknown server is not found', async () => {
    await expect(Boosts.mutateVanityAtomic(`${P}-missing`, OWNER_A, 'pgt-vanity-four')).resolves.toBe('not_found');
  });

  it('two entitled servers racing for one slug: exactly one wins, the other is a conflict', async () => {
    await boost(A, NEEDED);
    await boost(B, NEEDED);
    for (let round = 0; round < 5; round++) {
      const slug = `pgt-vanity-race-${round}`;
      const results = await Promise.all([
        Boosts.mutateVanityAtomic(A, OWNER_A, slug),
        Boosts.mutateVanityAtomic(B, OWNER_B, slug),
      ]);
      expect(results.sort()).toEqual(['conflict', 'ok']);
      const holders = await q(`SELECT _id FROM servers WHERE "vanityUrl"=$1`, [slug]);
      expect(holders).toHaveLength(1);
      await q(`UPDATE servers SET "vanityUrl"=NULL WHERE _id IN ($1, $2)`, [A, B]);
    }
  });
});
