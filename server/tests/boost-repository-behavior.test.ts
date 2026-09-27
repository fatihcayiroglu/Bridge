const query = jest.fn();
jest.mock('../db/postgres/pool', () => ({ pool: { query } }));
import { Boosts } from '../db/repositories/BoostRepository';
beforeEach(() => query.mockReset());
describe('BoostRepository live entitlement SQL', () => {
  it('derives server boost count/tier from non-expired active rows', async () => {
    query.mockResolvedValueOnce({ rows: [{ boostCount: 7, boostTier: 2 }] });
    await expect(Boosts.getServerBoostInfo('srv')).resolves.toEqual({ boostCount: 7, boostTier: 2 });
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('b.active=TRUE'); expect(sql).toContain('b."expiresAt" > $2');
    expect(sql).toContain('COALESCE(bm.banned, FALSE)=FALSE');
    expect(params[0]).toBe('srv'); expect(typeof params[1]).toBe('number');
  });
  it('filters expired boosters and active-boost lookup', async () => {
    query.mockResolvedValueOnce({ rows: [] }); await Boosts.getBoosters('srv');
    expect(query.mock.calls[0][0]).toContain('"expiresAt" > $2');
    expect(query.mock.calls[0][0]).toContain('COALESCE(bm.banned, FALSE)=FALSE');
    query.mockResolvedValueOnce({ rows: [{ _id:'x' }] });
    await expect(Boosts.getActiveBoost('srv','u')).resolves.toEqual({ _id:'x' });
    expect(query.mock.calls[1][0]).toContain('"expiresAt" > $3');
    expect(query.mock.calls[1][0]).toContain('COALESCE(bm.banned, FALSE)=FALSE');
  });
  it('deactivates expired unique-index rows and reports insert winner', async () => {
    query.mockResolvedValueOnce({ rowCount: 1, rows: [] }).mockResolvedValueOnce({ rowCount: 1, rows:[{_id:'new'}] });
    await expect(Boosts.addBoost('srv','u',Date.now()+1000)).resolves.toBe(true);
    expect(query.mock.calls[0][0]).toContain('SET active=FALSE'); expect(query.mock.calls[1][0]).toContain('RETURNING _id');
    query.mockReset(); query.mockResolvedValueOnce({ rowCount: 0, rows: [] }).mockResolvedValueOnce({ rowCount: 0, rows: [] });
    await expect(Boosts.addBoost('srv','u',Date.now()+1000)).resolves.toBe(false);
  });
  it('counts only live boosts and excludes banned memberships from user tier', async () => {
    query.mockResolvedValueOnce({ rows:[{count:'14'}] }); await expect(Boosts.countActiveBoosts('srv')).resolves.toBe(14);
    expect(query.mock.calls[0][0]).toContain('"expiresAt" > $2');
    expect(query.mock.calls[0][0]).toContain('COALESCE(bm.banned, FALSE)=FALSE');
    query.mockResolvedValueOnce({ rows:[{boostTier:3}] }); await expect(Boosts.getHighestActiveTierForUser('u')).resolves.toBe(3);
    const sql = query.mock.calls[1][0]; expect(sql).toContain('COALESCE(m.banned, FALSE)=FALSE'); expect(sql).toContain('b."expiresAt" > $2');
    expect(sql).toContain('COALESCE(bm.banned, FALSE)=FALSE');
  });
  it('resolves vanity only while live level-3 entitlement exists', async () => {
    query.mockResolvedValueOnce({ rows:[{ _id:'srv', name:'S', icon:'', description:'' }] });
    await expect(Boosts.getByVanityUrl('nice')).resolves.toMatchObject({ _id:'srv' });
    let sql = query.mock.calls[0][0];
    expect(sql).toContain('LOWER(s."vanityUrl")=$1');
    expect(sql).toContain('>= 14');
    expect(sql).toContain('b."expiresAt" > $2');
    expect(sql).toContain('COALESCE(bm.banned, FALSE)=FALSE');

    query.mockResolvedValueOnce({ rows:[{ _id:'srv', name:'S' }] });
    await expect(Boosts.getLiveVanityServer('nice')).resolves.toMatchObject({ _id:'srv' });
    sql = query.mock.calls[1][0];
    expect(sql).toContain('>= 14');
    expect(sql).toContain('COALESCE(bm.banned, FALSE)=FALSE');
  });

  it('mutates vanity atomically with owner, live tier, and uniqueness predicates', async () => {
    query.mockResolvedValueOnce({ rowCount:1, rows:[{ _id:'srv' }] });
    await expect(Boosts.mutateVanityAtomic('srv','owner','nice')).resolves.toBe('ok');
    const [sql, params] = query.mock.calls[0];
    expect(sql).toContain('s."ownerId"=$2');
    expect(sql).toContain('>= 14');
    expect(sql).toContain('COALESCE(bm.banned, FALSE)=FALSE');
    expect(sql).toContain('NOT EXISTS');
    expect(params.slice(0,3)).toEqual(['srv','owner','nice']);
  });

  it('allows an owner to clear stale vanity without requiring a live boost tier', async () => {
    query.mockResolvedValueOnce({ rowCount:1, rows:[{ _id:'srv' }] });
    await expect(Boosts.mutateVanityAtomic('srv','owner',null)).resolves.toBe('ok');
    expect(query.mock.calls[0][1][2]).toBeNull();
  });

  it('maps unique-index race losers to conflict', async () => {
    query.mockRejectedValueOnce(Object.assign(new Error('duplicate key value violates unique constraint'), { code:'23505' }));
    await expect(Boosts.mutateVanityAtomic('srv','owner','nice')).resolves.toBe('conflict');
  });

  it('classifies atomic mutation misses without weakening entitlement', async () => {
    query.mockResolvedValueOnce({ rowCount:0, rows:[] })
      .mockResolvedValueOnce({ rows:[] });
    await expect(Boosts.mutateVanityAtomic('missing','owner','nice')).resolves.toBe('not_found');

    query.mockReset();
    query.mockResolvedValueOnce({ rowCount:0, rows:[] })
      .mockResolvedValueOnce({ rows:[{ ownerId:'other', boostTier:3 }] });
    await expect(Boosts.mutateVanityAtomic('srv','owner','nice')).resolves.toBe('forbidden');

    query.mockReset();
    query.mockResolvedValueOnce({ rowCount:0, rows:[] })
      .mockResolvedValueOnce({ rows:[{ ownerId:'owner', boostTier:2 }] });
    await expect(Boosts.mutateVanityAtomic('srv','owner','nice')).resolves.toBe('boost_required');
  });

  it('falls back to zero tier/count when rows are absent', async () => {
    query.mockResolvedValueOnce({ rows:[{}] }); await expect(Boosts.countActiveBoosts('srv')).resolves.toBe(0);
    query.mockResolvedValueOnce({ rows:[{}] }); await expect(Boosts.getHighestActiveTierForUser('u')).resolves.toBe(0);
  });
  it('derives vanity eligibility from live boost count rather than cached tier', async () => {
    query.mockResolvedValueOnce({ rows:[{ ownerId:'owner', boostTier:0 }] }); await Boosts.getServerOwnerAndTier('srv');
    const sql = query.mock.calls[0][0]; expect(sql).toContain('LEFT JOIN LATERAL'); expect(sql).toContain('b."expiresAt" > $2');
  });
});
