process.env.NODE_ENV = 'test';

const mockDb: any = {};
function col() { return { find: jest.fn(), findOne: jest.fn(), insert: jest.fn(), update: jest.fn(), remove: jest.fn(), count: jest.fn() }; }
function resetDb() {
  Object.assign(mockDb, {
    federationPeers: col(), federationWhitelist: col(), federationBlacklist: col(),
    apActivities: col(), apFollows: col(), apOutgoingFollows: col(), apMessages: col(),
    apLikes: col(), apAnnounces: col(), apDeliveryQueue: col(),
  });
  delete mockDb._pool;
}
resetDb();
jest.mock('../db/loader', () => mockDb);

import fs from 'fs';
import path from 'path';
import Federation from '../db/repositories/FederationRepository';

const delivery = { payload: { inboxUrl: 'https://remote.test/inbox', activity: { type: 'Create' } }, attempts: 1, nextAt: 2000, createdAt: 1000 };

describe('FederationRepository canonical storage and lease contracts', () => {
  beforeEach(() => { jest.clearAllMocks(); resetDb(); });

  it('peer and ACL list wrappers normalize missing results without swallowing store failures', async () => {
    mockDb.federationPeers.find.mockResolvedValue(undefined);
    mockDb.federationWhitelist.find.mockResolvedValue(undefined);
    mockDb.federationBlacklist.find.mockResolvedValue(undefined);
    await expect(Federation.findPeers()).resolves.toEqual([]);
    await expect(Federation.findWhitelist()).resolves.toEqual([]);
    await expect(Federation.findBlacklist()).resolves.toEqual([]);

    await Federation.findPeerByUrl('https://peer.test');
    expect(mockDb.federationPeers.findOne).toHaveBeenCalledWith({ url: 'https://peer.test' });
    await Federation.getPeerByUrl('https://peer.test');
    await Federation.insertPeer({ _id: 'p1' });
    await Federation.updatePeer('p1', { $set: { active: true } });
    await Federation.updatePeersWhere({ active: false }, { $set: { active: true } });
    await Federation.removePeerById('p1');
    expect(mockDb.federationPeers.remove).toHaveBeenCalledWith({ _id: 'p1' });

    mockDb.federationBlacklist.find.mockRejectedValueOnce(new Error('acl down'));
    await expect(Federation.findBlacklist()).rejects.toThrow('acl down');
  });

  it('forwards ACL CRUD to the canonical stores', async () => {
    await Federation.findWhitelistOne({ domain: 'a.test' });
    await Federation.insertWhitelist({ domain: 'a.test' });
    await Federation.removeWhitelistByDomain('a.test');
    expect(mockDb.federationWhitelist.remove).toHaveBeenCalledWith({ domain: 'a.test' });
    await Federation.findBlacklistOne({ domain: 'b.test' });
    await Federation.insertBlacklist({ domain: 'b.test' });
    await Federation.removeBlacklistByDomain('b.test');
    expect(mockDb.federationBlacklist.remove).toHaveBeenCalledWith({ domain: 'b.test' });
  });

  it('FED-02: ACL inserts write only the real columns of federation_whitelist / federation_blacklist', async () => {
    // Route-shaped entry: addedAt / addedBy are API fields, not PostgreSQL columns.
    const entry = { _id: 'acl-1', domain: 'evil.test', reason: 'spam', addedAt: 1700000000000, addedBy: 'admin-1' };
    await Federation.insertBlacklist({ ...entry });
    await Federation.insertWhitelist({ ...entry, _id: 'acl-2', domain: 'good.test' });
    const blackRow = mockDb.federationBlacklist.insert.mock.calls[0][0];
    const whiteRow = mockDb.federationWhitelist.insert.mock.calls[0][0];
    expect(blackRow).toEqual({ _id: 'acl-1', domain: 'evil.test', reason: 'spam', createdAt: 1700000000000 });
    expect(whiteRow).toEqual({ _id: 'acl-2', domain: 'good.test', reason: 'spam', createdAt: 1700000000000 });

    // Every key must be a column of the DDL the server actually runs.
    const ddl = fs.readFileSync(path.join(__dirname, '..', 'db', 'postgres', 'migrations.ts'), 'utf8');
    for (const table of ['federation_whitelist', 'federation_blacklist']) {
      const m = ddl.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n  \\)`));
      expect(m).not.toBeNull();
      const columns = new Set(m![1].split('\n').map((l) => l.trim().split(/\s+/)[0]?.replace(/"/g, '')).filter(Boolean));
      for (const key of Object.keys(blackRow)) expect(columns).toContain(key);
    }

    // A row with no timestamp still satisfies the NOT NULL "createdAt".
    await Federation.insertBlacklist({ domain: 'x.test' });
    expect(mockDb.federationBlacklist.insert.mock.calls[1][0]).toEqual({ domain: 'x.test', createdAt: expect.any(Number) });
  });

  it('forwards ActivityPub collection operations and normalizes async list fallbacks', async () => {
    mockDb.apFollows.find.mockResolvedValue(undefined);
    mockDb.apOutgoingFollows.find.mockResolvedValue(undefined);
    mockDb.apMessages.find.mockResolvedValue(undefined);
    await expect(Federation.findApFollows({ targetUserId: 'u1' })).resolves.toEqual([]);
    await expect(Federation.findApOutgoingFollows({ fromUserId: 'u1' })).resolves.toEqual([]);
    await expect(Federation.findApMessages({ actorUrl: 'https://a' })).resolves.toEqual([]);

    await Federation.insertActivity({ _id: 'a1' });
    await Federation.updateActivity({ _id: 'a1' }, { $set: { processed: true } });
    Federation.apActivitiesFind({ type: 'Create' });
    await Federation.findActivities({ type: 'Create' });
    await Federation.countActivities({ type: 'Create' });

    await Federation.findApFollowOne({ actorUrl: 'a' }); await Federation.insertApFollow({ _id: 'f1' });
    await Federation.updateApFollow({ _id: 'f1' }, { $set: { accepted: true } }); await Federation.removeApFollow({ _id: 'f1' }, {});
    await Federation.findApOutgoingFollowOne({ _id: 'of1' }); await Federation.insertApOutgoingFollow({ _id: 'of1' });
    await Federation.updateApOutgoingFollow({ _id: 'of1' }, { $set: { accepted: true } }); await Federation.removeApOutgoingFollow({ _id: 'of1' }, {});
    await Federation.findApMessageOne({ apId: 'm1' }); await Federation.insertApMessage({ _id: 'm1' });
    await Federation.updateApMessage({ _id: 'm1' }, { $set: { content: 'x' } }); await Federation.removeApMessage({ _id: 'm1' }, {});
    Federation.apMessagesFind({ actorUrl: 'a' }); await Federation.countApMessages({ actorUrl: 'a' });
    await Federation.findApLikeOne({ objectUrl: 'o' }); await Federation.insertApLike({ _id: 'l1' }); await Federation.removeApLike({ _id: 'l1' }, {});
    await Federation.insertApAnnounce({ _id: 'n1' }); await Federation.removeApAnnounce({ _id: 'n1' }, {});
  });

  it('validates inbound activity lease identity before durable state and truncates failure reasons', async () => {
    const base = { id: 'j1', targetUserId: 'u1', actorUrl: 'https://remote.test/u/a', activityId: 'https://remote.test/a/1', type: 'Create', activity: { type: 'Create' }, claimOwner: 'w1', claimUntil: 2000, createdAt: 1000 };
    for (const bad of [
      { ...base, id: '' }, { ...base, claimOwner: '' }, { ...base, activity: [] as any },
      { ...base, claimUntil: 1000 }, { ...base, createdAt: -1 },
    ]) await expect(Federation.claimInboundActivity(bad)).rejects.toThrow(/Invalid ActivityPub/);
    expect(mockDb.apActivities.findOne).not.toHaveBeenCalled();

    mockDb.apActivities.update.mockResolvedValue(undefined);
    await Federation.failInboundActivity('j1', 'w1', 'x'.repeat(1200));
    const mod = mockDb.apActivities.update.mock.calls[0][1];
    expect(mod.$set.lastError).toHaveLength(1000);
    await expect(Federation.failInboundActivity('j1', 'w1', '')).rejects.toThrow(/failure reason/);
  });

  it('PostgreSQL inbound claim handles claimed, processed/busy conflict and disappeared conflict truthfully', async () => {
    const base = { id: 'j1', targetUserId: 'u1', actorUrl: 'https://remote.test/u/a', activityId: 'https://remote.test/a/1', type: 'Create', activity: { type: 'Create' }, claimOwner: 'w1', claimUntil: 2000, createdAt: 1000 };
    const query = jest.fn<Promise<unknown>, unknown[]>().mockResolvedValueOnce({ rows: [{ _id: 'j1', processed: false }] });
    mockDb._pool = { query };
    await expect(Federation.claimInboundActivity(base)).resolves.toEqual({ status: 'claimed', id: 'j1' });
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT');

    query.mockReset().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ _id: 'j1', processed: true }] });
    await expect(Federation.claimInboundActivity(base)).resolves.toEqual({ status: 'processed', id: 'j1' });
    query.mockReset().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ _id: 'j1', processed: false }] });
    await expect(Federation.claimInboundActivity(base)).resolves.toEqual({ status: 'busy', id: 'j1' });
    query.mockReset().mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(Federation.claimInboundActivity(base)).rejects.toThrow(/disappeared/);
  });

  it('completion enforces claim ownership in PostgreSQL and fallback modes', async () => {
    const query = jest.fn<Promise<unknown>, unknown[]>().mockResolvedValueOnce({ rows: [{ _id: 'j1' }] }); mockDb._pool = { query };
    await Federation.completeInboundActivity('j1', 'w1', 3000);
    expect(query.mock.calls[0][1]).toEqual(['j1', 'w1', 3000]);
    query.mockResolvedValueOnce({ rows: [] });
    await expect(Federation.completeInboundActivity('j1', 'w1', 3001)).rejects.toThrow(/ownership lost/);
    await expect(Federation.completeInboundActivity('', 'w1', 3001)).rejects.toThrow(/journal id/);

    delete mockDb._pool;
    mockDb.apActivities.findOne.mockResolvedValueOnce(null);
    await expect(Federation.completeInboundActivity('j1', 'w1', 3002)).rejects.toThrow(/ownership lost/);
    mockDb.apActivities.findOne.mockResolvedValueOnce({ _id: 'j1' });
    await Federation.completeInboundActivity('j1', 'w1', 3003);
    expect(mockDb.apActivities.update).toHaveBeenCalledWith({ _id: 'j1', claimOwner: 'w1', processed: false }, expect.any(Object));
  });

  it('delivery upsert validates durable fields and cannot let caller override canonical id in fallback', async () => {
    for (const doc of [
      { ...delivery, attempts: -1 }, { ...delivery, nextAt: 1.5 }, { ...delivery, createdAt: -1 }, { ...delivery, payload: null },
    ]) await expect(Federation.upsertDeliveryEntry('q1', doc as any)).rejects.toThrow(/queue document/);
    await expect(Federation.upsertDeliveryEntry('', delivery)).rejects.toThrow(/delivery id/);

    mockDb.apDeliveryQueue.findOne.mockResolvedValueOnce(null);
    mockDb.apDeliveryQueue.insert.mockImplementation(async (row: any) => row);
    const row: any = await Federation.upsertDeliveryEntry('canonical', { ...delivery, _id: 'attacker' });
    expect(row._id).toBe('canonical');

    mockDb.apDeliveryQueue.findOne.mockResolvedValueOnce({ _id: 'canonical' });
    await Federation.upsertDeliveryEntry('canonical', delivery);
    expect(mockDb.apDeliveryQueue.update).toHaveBeenCalledWith({ _id: 'canonical' }, { $set: delivery });
  });

  it('PostgreSQL delivery upsert uses a single canonical UPSERT', async () => {
    const query = jest.fn<Promise<unknown>, unknown[]>().mockResolvedValue({ rows: [] }); mockDb._pool = { query };
    await Federation.upsertDeliveryEntry('q1', delivery);
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT (_id) DO UPDATE');
    expect(query.mock.calls[0][1]).toEqual(['q1', JSON.stringify(delivery.payload), 1, 2000, 1000]);
  });

  it('delivery claim bounds lease/limit and commits a PostgreSQL SKIP LOCKED transaction', async () => {
    // Imza URUN cagrisini yansitir: `query(sql, params)`.
    const client = { query: jest.fn(async (sql: string, _params?: readonly unknown[]) => sql.includes('WITH due') ? { rows: [{ _id: 'q1' }] } : { rows: [] }), release: jest.fn() };
    mockDb._pool = { connect: jest.fn(async () => client) };
    const rows = await Federation.claimPendingDeliveries(1000, 'worker', 9999999, 1000);
    expect(rows).toEqual([{ _id: 'q1' }]);
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', expect.stringContaining('FOR UPDATE SKIP LOCKED'), 'COMMIT']);
    expect(client.query.mock.calls[1][1]).toEqual([1000, 'worker', 601000, 100]);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('delivery claim rolls back PostgreSQL failures and fallback claims only due unleased rows', async () => {
    const original = new Error('claim failed');
    const client = { query: jest.fn(async (sql: string) => { if (sql.includes('WITH due')) throw original; return { rows: [] }; }), release: jest.fn() };
    mockDb._pool = { connect: jest.fn(async () => client) };
    await expect(Federation.claimPendingDeliveries(1000, 'worker')).rejects.toBe(original);
    expect(client.query).toHaveBeenCalledWith('ROLLBACK'); expect(client.release).toHaveBeenCalledTimes(1);

    delete mockDb._pool;
    const cursor: any = Promise.resolve([
      { _id: 'due', nextAt: 1, claimUntil: 0 }, { _id: 'busy', nextAt: 2, claimUntil: 5000 },
    ]);
    cursor.sort = jest.fn(() => cursor);
    mockDb.apDeliveryQueue.find.mockReturnValueOnce(cursor);
    mockDb.apDeliveryQueue.update.mockResolvedValue(undefined);
    await expect(Federation.claimPendingDeliveries(1000, 'worker', 120000, 50)).resolves.toEqual([
      expect.objectContaining({ _id: 'due', claimOwner: 'worker', claimUntil: 121000 }),
    ]);
    expect(mockDb.apDeliveryQueue.update).toHaveBeenCalledTimes(1);
  });

  // Dizi ACIKCA tiplenir: aksi hâlde her satir kendi nesne edebisi tipini
  // aliyor ve geri cagrim parametresi bir BIRLESIM oluyordu.
  it.each<[Record<string, unknown>, string]>([
    [{ ...delivery, attempts: '01' }, 'queue document'],
    [{ ...delivery, nextAt: '2e3' }, 'queue document'],
    [{ ...delivery, createdAt: ' 1000' }, 'queue document'],
  ])('delivery release rejects non-canonical persisted numeric state %#', async (corrupt) => {
    await expect(Federation.releaseDeliveryClaim('q1', 'w1', corrupt)).rejects.toThrow(/Invalid ActivityPub delivery queue document/);
    expect(mockDb.apDeliveryQueue.update).not.toHaveBeenCalled();
  });

  it('fallback delivery claim rejects a corrupt durable lease instead of reinterpreting it', async () => {
    const cursor: any = Promise.resolve([{ _id: 'corrupt', nextAt: 1, claimUntil: '1e3' }]);
    cursor.sort = jest.fn(() => cursor);
    mockDb.apDeliveryQueue.find.mockReturnValueOnce(cursor);
    await expect(Federation.claimPendingDeliveries(1000, 'worker')).rejects.toThrow(/persisted epoch timestamp/);
    expect(mockDb.apDeliveryQueue.update).not.toHaveBeenCalled();
  });

  it('release/remove/pending/count operations enforce durable identity and truthful reads', async () => {
    await Federation.releaseDeliveryClaim('q1', 'w1', delivery);
    expect(mockDb.apDeliveryQueue.update).toHaveBeenCalledWith({ _id: 'q1', claimOwner: 'w1' }, { $set: { ...delivery, claimOwner: null, claimUntil: null } });
    await expect(Federation.releaseDeliveryClaim('q1', '', delivery)).rejects.toThrow(/claim owner/);
    await Federation.removeDeliveryEntry('q1', 'w1'); expect(mockDb.apDeliveryQueue.remove).toHaveBeenLastCalledWith({ _id: 'q1', claimOwner: 'w1' });
    await Federation.removeDeliveryEntry('q2'); expect(mockDb.apDeliveryQueue.remove).toHaveBeenLastCalledWith({ _id: 'q2' });
    await expect(Federation.findPendingDeliveries(-1)).rejects.toThrow(/deadline/);
    mockDb.apDeliveryQueue.find.mockResolvedValueOnce(undefined); await expect(Federation.findPendingDeliveries(1000)).resolves.toEqual([]);
    mockDb.apDeliveryQueue.find.mockResolvedValueOnce([{ _id: 'a' }, { _id: 'b' }]); await expect(Federation.countPendingDeliveries()).resolves.toBe(2);
    mockDb.apDeliveryQueue.find.mockResolvedValueOnce({ bad: true }); await expect(Federation.countPendingDeliveries()).rejects.toThrow(/invalid result/);
  });
});
