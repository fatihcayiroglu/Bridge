// Durable federation state must never report success when persistence failed.
'use strict';
process.env.NODE_ENV = 'test';

const dbFailure = new Error('postgres unavailable');
const collections = {
  federationPeers: { find: jest.fn(), findOne: jest.fn(), insert: jest.fn(), update: jest.fn(), remove: jest.fn() },
  federationWhitelist: { find: jest.fn(), findOne: jest.fn(), insert: jest.fn(), remove: jest.fn() },
  federationBlacklist: { find: jest.fn(), findOne: jest.fn(), insert: jest.fn(), remove: jest.fn() },
  apActivities: { insert: jest.fn(), findOne: jest.fn(), update: jest.fn(), find: jest.fn(), count: jest.fn() },
  apFollows: { findOne: jest.fn(), insert: jest.fn(), update: jest.fn(), remove: jest.fn(), find: jest.fn() },
  apOutgoingFollows: { findOne: jest.fn(), insert: jest.fn(), update: jest.fn(), remove: jest.fn(), find: jest.fn() },
  apMessages: { insert: jest.fn(), update: jest.fn(), remove: jest.fn(), find: jest.fn(), count: jest.fn() },
  apLikes: { findOne: jest.fn(), insert: jest.fn(), remove: jest.fn() },
  apAnnounces: { insert: jest.fn(), remove: jest.fn() },
  apDeliveryQueue: { findOne: jest.fn(), find: jest.fn(), insert: jest.fn(), update: jest.fn(), remove: jest.fn() },
};

jest.mock('../db/loader', () => collections);

import Federation from '../db/repositories/FederationRepository';

describe('FederationRepository durable failure visibility', () => {
  beforeEach(() => jest.clearAllMocks());

  it('AP message persistence rejects instead of becoming a fake success', async () => {
    collections.apMessages.insert.mockRejectedValueOnce(dbFailure);
    await expect(Federation.insertApMessage({ _id: 'm1' })).rejects.toThrow('postgres unavailable');
  });

  it('AP message delete failure rejects instead of silently disappearing', async () => {
    collections.apMessages.remove.mockRejectedValueOnce(dbFailure);
    await expect(Federation.removeApMessage({ apId: 'remote-note' }, {})).rejects.toThrow('postgres unavailable');
  });

  it('retry-queue upsert read/write failures remain visible to the retry worker', async () => {
    const valid = { payload: { inboxUrl: 'https://remote.test/inbox', activity: {} }, attempts: 1, nextAt: 2000, createdAt: 1000 };
    collections.apDeliveryQueue.findOne.mockRejectedValueOnce(dbFailure);
    await expect(Federation.upsertDeliveryEntry('retry-1', valid)).rejects.toThrow('postgres unavailable');

    collections.apDeliveryQueue.findOne.mockResolvedValueOnce(null);
    collections.apDeliveryQueue.insert.mockRejectedValueOnce(dbFailure);
    await expect(Federation.upsertDeliveryEntry('retry-2', valid)).rejects.toThrow('postgres unavailable');
  });

  it('pending-queue read failure does not masquerade as an empty queue', async () => {
    collections.apDeliveryQueue.find.mockRejectedValueOnce(dbFailure);
    await expect(Federation.findPendingDeliveries(Date.now())).rejects.toThrow('postgres unavailable');
  });


  it('count failures remain visible instead of fabricating empty federation state', async () => {
    collections.apActivities.count.mockRejectedValueOnce(dbFailure);
    await expect(Federation.countActivities({ actorUserId: 'u1' })).rejects.toThrow('postgres unavailable');
    collections.apMessages.count.mockRejectedValueOnce(dbFailure);
    await expect(Federation.countApMessages({ actorUrl: 'https://remote.test/a' })).rejects.toThrow('postgres unavailable');
    collections.apDeliveryQueue.find.mockRejectedValueOnce(dbFailure);
    await expect(Federation.countPendingDeliveries()).rejects.toThrow('postgres unavailable');
  });

  it('missing ACL and AP stores fail closed instead of looking empty/successful', async () => {
    const acl = collections.federationBlacklist;
    const activities = collections.apActivities;
    const queue = collections.apDeliveryQueue;
    try {
      (collections as any).federationBlacklist = undefined;
      await expect(Federation.findBlacklist()).rejects.toThrow();
      (collections as any).apActivities = undefined;
      await expect(Federation.insertActivity({ _id: 'a1' })).rejects.toThrow();
      (collections as any).apDeliveryQueue = undefined;
      await expect(Federation.insertDeliveryEntry({ _id: 'q1' })).rejects.toThrow();
    } finally {
      (collections as any).federationBlacklist = acl;
      (collections as any).apActivities = activities;
      (collections as any).apDeliveryQueue = queue;
    }
  });

  it('rejects malformed lease parameters before touching durable state', async () => {
    const now = Date.now();
    for (const args of [
      [-1, 'worker', 120000, 50],
      [now, '', 120000, 50],
      [now, 'worker', 1.5, 50],
      [now, 'worker', 120000, 0],
      [Number.MAX_SAFE_INTEGER, 'worker', 120000, 50],
    ] as const) {
      // `as const` demeti SALT OKUNURdur; yayilim icin degistirilebilir bir
      // demet gerekiyor. Degerler ayni, yalnizca okunurluk kalkiyor.
      const [beforeTs, owner, leaseMs, limit] = args;
      await expect(Federation.claimPendingDeliveries(beforeTs, owner, leaseMs, limit))
        .rejects.toThrow(/Invalid ActivityPub delivery claim/);
    }
  });
});


describe('FederationRepository inbound activity claim fallback contract', () => {
  const base = {
    id: 'journal-new', targetUserId: 'local-user', actorUrl: 'https://remote.test/u/a',
    activityId: 'https://remote.test/activities/1', type: 'Create', activity: { type: 'Create' },
    claimOwner: 'worker-a', claimUntil: 999999, createdAt: 1000,
  };

  beforeEach(() => jest.clearAllMocks());

  it('creates a durable claim before handler execution', async () => {
    collections.apActivities.findOne.mockResolvedValueOnce(null);
    collections.apActivities.insert.mockResolvedValueOnce({});
    await expect(Federation.claimInboundActivity(base)).resolves.toEqual({ status: 'claimed', id: 'journal-new' });
    expect(collections.apActivities.insert).toHaveBeenCalledWith(expect.objectContaining({
      activityId: base.activityId, actorUrl: base.actorUrl, processed: false, attempts: 1,
    }));
  });

  it('processed retry is a no-op and active foreign lease is busy', async () => {
    collections.apActivities.findOne.mockResolvedValueOnce({ _id: 'done', processed: true });
    await expect(Federation.claimInboundActivity(base)).resolves.toEqual({ status: 'processed', id: 'done' });

    collections.apActivities.findOne.mockResolvedValueOnce({
      _id: 'busy', processed: false, claimOwner: 'worker-b', claimUntil: 5000,
    });
    await expect(Federation.claimInboundActivity(base)).resolves.toEqual({ status: 'busy', id: 'busy' });
  });

  it('expired lease can be reclaimed and increments attempt count', async () => {
    collections.apActivities.findOne.mockResolvedValueOnce({
      _id: 'retry', processed: false, claimOwner: 'dead-worker', claimUntil: 999,
    });
    collections.apActivities.update.mockResolvedValueOnce({ updated: 1 });
    await expect(Federation.claimInboundActivity(base)).resolves.toEqual({ status: 'claimed', id: 'retry' });
    expect(collections.apActivities.update).toHaveBeenCalledWith(
      { _id: 'retry' },
      expect.objectContaining({ $inc: { attempts: 1 } }),
    );
  });
});
