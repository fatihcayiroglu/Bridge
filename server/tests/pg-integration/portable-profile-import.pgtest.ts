// P7 C3 — real PostgreSQL proof: atomic compare-and-swap profile import.
// Mock route tests cannot prove SQL predicates under concurrent writers.
import express from 'express';
import request from 'supertest';

const TARGET = 'pgt-pimp-target';
const OTHER = 'pgt-pimp-other';
const ids = [TARGET, OTHER];

jest.mock('../../middleware/auth', () => ({
  authMiddleware: (req: { user?: { id: string } }, _res: unknown, next: () => void) => {
    req.user = { id: 'pgt-pimp-target' };
    next();
  },
  _invalidateTokenCache: jest.fn(),
}));
jest.mock('../../middleware/rateLimit', () => ({
  limits: new Proxy({}, { get: () => () => (_req: unknown, _res: unknown, next: () => void) => next() }),
}));

const db = require('../../db/loader').default;
const accountRouter = require('../../routes/account').default;
const { buildPortableIdentityExport } = require('../../lib/portableIdentity') as typeof import('../../lib/portableIdentity');
const { stepUpHeader } = require('../helpers/stepUp') as typeof import('../helpers/stepUp');
const RUN = process.env.PG_TEST_URL ? describe : describe.skip;
const q = async (sql: string, params: unknown[] = []) => (await db._pool.query(sql, params)).rows;

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/account', accountRouter);
  return a;
}

function documentFor(displayName: string) {
  return buildPortableIdentityExport(OTHER, {
    username: 'remote_user', displayName, bio: 'Imported biography',
    website: 'https://origin.example', pronouns: 'they/them',
    avatarColor: '', bannerColor: '#aabbcc',
  }, '2026-10-11T12:00:00.000Z');
}

async function preview(document: unknown) {
  const r = await request(app()).post('/api/account/portable-import/preview')
    .set(stepUpHeader(TARGET, 'sensitive-export')).send(document);
  expect(r.status).toBe(200);
  const expected = Object.fromEntries(
    r.body.fields.map((item: { field: string; current: string }) => [item.field, item.current]),
  );
  return { expected, result: r.body };
}

RUN('P7 C3 real PostgreSQL — portable import atomicity and conflict isolation', () => {
  const reset = async () => {
    await q(`UPDATE users SET "displayName"='Existing Name', bio='existing bio',
      website='', pronouns='', "avatarColor"='#223344',
      "bannerColor"='#445566' WHERE _id=$1`, [TARGET]);
  };
  beforeAll(async () => {
    await q('DELETE FROM users WHERE _id = ANY($1::text[])', [ids]);
    await q(`INSERT INTO users (_id, username, "displayName", password, "createdAt", "avatarColor", "bannerColor")
      VALUES ($1,'pgt_pimp_target','Existing Name','dummy',1,'#223344','#445566'),
             ($2,'pgt_pimp_other','Other Account','dummy',1,'#112233','#667788')`, ids);
  });
  beforeEach(reset);
  afterAll(async () => {
    await q('DELETE FROM users WHERE _id = ANY($1::text[])', [ids]);
  });

  it('applies only six approved target fields, preserving identity, other accounts and unspecified color', async () => {
    const source = documentFor('Moved Name');
    const { expected, result: dry } = await preview(source);
    expect(dry).toMatchObject({ dryRun: true, applied: false, checksumVerified: true });
    expect(dry.mapping).toEqual(expect.objectContaining({ targetUserId: TARGET, sourceUserId: OTHER }));
    expect(dry.fields.find((f: { field: string }) => f.field === 'avatarColor')).toMatchObject({
      current: '#223344', proposed: '#223344', changed: false,
    });
    const refused = await request(app()).post('/api/account/portable-import/apply')
      .send({ document: source, expected, confirm: 'APPLY_PORTABLE_PROFILE' });
    expect(refused.status).toBe(403);

    const accepted = await request(app()).post('/api/account/portable-import/apply')
      .set(stepUpHeader(TARGET, 'sensitive-export'))
      .send({ document: source, expected, confirm: 'APPLY_PORTABLE_PROFILE' });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ ok: true, applied: true, targetUserId: TARGET });
    const [target] = await q(`SELECT _id, username, "displayName", bio, website, pronouns,
      "avatarColor", "bannerColor", password FROM users WHERE _id=$1`, [TARGET]);
    expect(target).toMatchObject({
      _id: TARGET, username: 'pgt_pimp_target', password: 'dummy',
      displayName: 'Moved Name', bio: 'Imported biography',
      website: 'https://origin.example', pronouns: 'they/them',
      avatarColor: '#223344', bannerColor: '#aabbcc',
    });
    const [other] = await q('SELECT username, "displayName", "avatarColor" FROM users WHERE _id=$1', [OTHER]);
    expect(other).toEqual({ username: 'pgt_pimp_other', displayName: 'Other Account', avatarColor: '#112233' });
  });

  it('returns 409 after a concurrent destination edit, preserving every unrelated field', async () => {
    const source = documentFor('Outdated Preview');
    const { expected } = await preview(source);
    await q('UPDATE users SET bio=$2 WHERE _id=$1', [TARGET, 'edited from another session']);
    const r = await request(app()).post('/api/account/portable-import/apply')
      .set(stepUpHeader(TARGET, 'sensitive-export'))
      .send({ document: source, expected, confirm: 'APPLY_PORTABLE_PROFILE' });
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('PORTABLE_PROFILE_CONFLICT');
    const [row] = await q('SELECT "displayName", bio, "bannerColor" FROM users WHERE _id=$1', [TARGET]);
    expect(row).toEqual({ displayName: 'Existing Name', bio: 'edited from another session', bannerColor: '#445566' });
  });

  it('two simultaneous apply attempts from one preview cannot both write', async () => {
    const source1 = documentFor('First Proposal');
    const source2 = documentFor('Second Proposal');
    const { expected } = await preview(source1);
    const proof = stepUpHeader(TARGET, 'sensitive-export');
    const requests = [source1, source2].map(document => request(app()).post('/api/account/portable-import/apply')
      .set(proof).send({ document, expected, confirm: 'APPLY_PORTABLE_PROFILE' }));
    const results = await Promise.all(requests);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    const [row] = await q('SELECT "displayName" FROM users WHERE _id=$1', [TARGET]);
    expect(['First Proposal', 'Second Proposal']).toContain(row.displayName);
  });
});
