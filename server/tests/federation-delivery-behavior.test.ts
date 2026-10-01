'use strict';
process.env.NODE_ENV = 'test';
process.env.INSTANCE_URL = 'https://bridge.example';

import { at, recordOf } from './helpers/narrow';
import crypto from 'crypto';

const fetchT = jest.fn();
const warn = jest.fn();
const info = jest.fn();
// ══════════════════════════════════════════════════════════════════════════
// IKIZLER ACIK JENERIKLERLE TIPLENIR
// ══════════════════════════════════════════════════════════════════════════
// `jest.fn(async () => [])` donus tipini `never[]` olarak CIKARIR; `async
// () => null` ise `null`. Sonuc: `mockResolvedValue([{...}])` ve
// `mockResolvedValue('pem...')` TS2345 veriyordu — cunku `ResolvedValue<T>`
// bu cikarimlarda sirasiyla `never` ve `null`dur.
//
// Acik jenerikler URUN imzalarindan alinir (FederationRepository /
// UserRepository). Boylece `mock.calls[0][1]` de dogru tiplenir ve
// `as { payload: ... }` cast'ine gerek kalmaz.

/** Teslim kuyrugu satiri — `normalizeDeliveryDoc` bu sekli uretir. */
type DeliveryDoc = Record<string, unknown>;
/** Takipci satiri — yalnizca teslimatta okunan alanlar. */
type FollowRow = { actorInbox?: string; actorUrl?: string; [key: string]: unknown };
/** Giden takip kaydi. */
type OutgoingFollowRow = { activityId?: string; [key: string]: unknown } | null;

const federation = {
  claimPendingDeliveries:  jest.fn<Promise<DeliveryDoc[]>, [beforeTs: number, claimOwner: string, leaseMs?: number, limit?: number]>(async () => []),
  removeDeliveryEntry:     jest.fn<Promise<void>, [id: string]>(async () => undefined),
  // P5 FED-05: outbound delivery consults the domain ACL; empty lists allow all.
  findBlacklist: jest.fn(async (): Promise<unknown[]> => []),
  findWhitelist: jest.fn(async (): Promise<unknown[]> => []),
  releaseDeliveryClaim:    jest.fn<Promise<unknown>, [id: string, claimOwner: string, doc: DeliveryDoc]>(async () => undefined),
  upsertDeliveryEntry:     jest.fn<Promise<unknown>, [id: string, doc: DeliveryDoc]>(async () => undefined),
  insertActivity:          jest.fn<Promise<unknown>, [doc: Record<string, unknown>]>(async () => undefined),
  findApFollows:           jest.fn<Promise<FollowRow[]>, [query: Record<string, unknown>]>(async () => []),
  insertApOutgoingFollow:  jest.fn<Promise<unknown>, [doc: Record<string, unknown>]>(async () => undefined),
  findApOutgoingFollowOne: jest.fn<Promise<OutgoingFollowRow>, [query: Record<string, unknown>]>(async () => null),
  removeApOutgoingFollow:  jest.fn<Promise<unknown>, [query: Record<string, unknown>]>(async () => undefined),
  insertApLike:            jest.fn<Promise<unknown>, [doc: Record<string, unknown>]>(async () => undefined),
  insertApAnnounce:        jest.fn<Promise<unknown>, [doc: Record<string, unknown>]>(async () => undefined),
};
const users = { getApPrivateKey: jest.fn<Promise<string | null>, [userId: string]>(async () => null) };
let seq = 0;

jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { warn, info } }));
jest.mock('../db/repositories', () => ({ Federation: federation, Users: users }));
jest.mock('uuid', () => ({ v4: jest.fn(() => `uuid-${++seq}`) }));

const delivery = require('../routes/federation/delivery') as typeof import('../routes/federation/delivery');

const actor = { _id: 'user-1', username: 'alice' };
const activity = { id: 'https://bridge.example/a/1', type: 'Create' };
const okResponse = () => ({ ok: true, status: 202, json: jest.fn() });

async function flushStartup(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('federation delivery production behavior', () => {
  beforeAll(async () => { await flushStartup(); });

  beforeEach(() => {
    jest.clearAllMocks();
    federation.claimPendingDeliveries.mockResolvedValue([]);
    federation.findApFollows.mockResolvedValue([]);
    federation.findApOutgoingFollowOne.mockResolvedValue(null);
    users.getApPrivateKey.mockResolvedValue(null);
    fetchT.mockResolvedValue(okResponse());
  });

  afterAll(() => {
    delete process.env.INSTANCE_URL;
  });

  it('persists intent before a direct-inbox POST and removes it only on success', async () => {
    const order: string[] = [];
    federation.upsertDeliveryEntry.mockImplementation(async () => { order.push('persist'); });
    fetchT.mockImplementation(async () => { order.push('post'); return okResponse(); });
    federation.removeDeliveryEntry.mockImplementation(async () => { order.push('ack'); });

    await delivery.deliverApActivity('https://remote.example/inbox', activity, null);

    expect(order).toEqual(['persist', 'post', 'ack']);
    expect(fetchT).toHaveBeenCalledWith('https://remote.example/inbox', expect.objectContaining({ method: 'POST' }));
  });

  it('resolves an actor to sharedInbox before delivering', async () => {
    fetchT
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ endpoints: { sharedInbox: 'https://remote.example/sharedInbox' }, inbox: 'https://remote.example/inbox' }) })
      .mockResolvedValueOnce(okResponse());

    await delivery.deliverApActivity('https://remote.example/users/bob', activity, null);

    expect(fetchT).toHaveBeenNthCalledWith(1, 'https://remote.example/users/bob', expect.objectContaining({ timeoutMs: 8000 }));
    expect(fetchT).toHaveBeenNthCalledWith(2, 'https://remote.example/sharedInbox', expect.objectContaining({ method: 'POST' }));
  });

  it('falls back to actor inbox when no sharedInbox exists', async () => {
    fetchT
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ inbox: 'https://remote.example/inbox' }) })
      .mockResolvedValueOnce(okResponse());

    await delivery.deliverApActivity('https://remote.example/users/bob', activity, null);
    expect(fetchT).toHaveBeenNthCalledWith(2, 'https://remote.example/inbox', expect.objectContaining({ method: 'POST' }));
  });

  it.each([
    ['actor without an inbox', { ok: true, status: 200, json: async () => ({}) }],
    ['actor lookup failure', new Error('lookup down')],
  ])('keeps the durable row queued when %s prevents target resolution', async (_label, result) => {
    if (result instanceof Error) fetchT.mockRejectedValueOnce(result);
    else fetchT.mockResolvedValueOnce(result);

    await delivery.deliverApActivity('https://remote.example/users/bob', activity, null);

    expect(federation.upsertDeliveryEntry).toHaveBeenCalledTimes(2); // initial intent + retry schedule
    expect(federation.removeDeliveryEntry).not.toHaveBeenCalled();
  });

  it('keeps the durable row queued after a transient network failure', async () => {
    fetchT.mockRejectedValueOnce(new Error('network down'));
    await delivery.deliverApActivity('https://remote.example/inbox', activity, null);
    expect(federation.upsertDeliveryEntry).toHaveBeenCalledTimes(2);
    expect(federation.removeDeliveryEntry).not.toHaveBeenCalled();
  });

  it('drops a permanently gone 410 target instead of retrying forever', async () => {
    fetchT.mockResolvedValueOnce({ ok: false, status: 410 });
    await delivery.deliverApActivity('https://remote.example/inbox', activity, null);
    expect(federation.removeDeliveryEntry).toHaveBeenCalledTimes(1);
    expect(federation.upsertDeliveryEntry).toHaveBeenCalledTimes(1);
  });

  it('requeues retryable non-2xx delivery failures', async () => {
    fetchT.mockResolvedValueOnce({ ok: false, status: 503 });
    await delivery.deliverApActivity('https://remote.example/inbox', activity, null);
    expect(federation.upsertDeliveryEntry).toHaveBeenCalledTimes(2);
    expect(federation.removeDeliveryEntry).not.toHaveBeenCalled();
  });

  it('uses a real RSA signature when the actor has a private key', async () => {
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 });
    users.getApPrivateKey.mockResolvedValue(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());

    await delivery.deliverApActivity('https://remote.example/inbox', activity, actor);

    const options = fetchT.mock.calls[0][1] as { headers: Record<string, string> };
    expect(options.headers.Digest).toMatch(/^SHA-256=/);
    expect(options.headers.Signature).toContain('keyId="https://bridge.example/api/federation/users/alice#main-key"');
  });

  it('signRequest returns null rather than throwing when key material is invalid', async () => {
    await expect(delivery.signRequest('POST', 'https://remote.example/inbox', '{}', 'not-a-key', 'alice')).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'federation.http_signature.sign_failed' }), expect.any(String));
  });

  it('stores an outbox activity and returns without delivery when there are no followers', async () => {
    await delivery.deliverToFollowers(actor, '<p>Hello</p>');
    expect(federation.insertActivity).toHaveBeenCalledWith(expect.objectContaining({ type: 'Create', actorUserId: actor._id }));
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('deduplicates follower delivery by shared inbox key', async () => {
    federation.findApFollows.mockResolvedValue([
      { actorInbox: 'https://r.example/sharedInbox', actorUrl: 'https://r.example/u/a' },
      { actorInbox: 'https://r.example/sharedInbox', actorUrl: 'https://r.example/u/b' },
      { actorInbox: 'https://s.example/inbox', actorUrl: 'https://s.example/u/c' },
    ]);
    await delivery.deliverToFollowers(actor, 'hello', 'https://bridge.example/note/fixed');
    expect(fetchT).toHaveBeenCalledTimes(2);
  });

  it('contains an individual fan-out queue failure and continues the batch', async () => {
    federation.findApFollows.mockResolvedValue([
      { actorInbox: 'https://bad.example/inbox', actorUrl: 'https://bad.example/u/a' },
      { actorInbox: 'https://good.example/inbox', actorUrl: 'https://good.example/u/b' },
    ]);
    federation.upsertDeliveryEntry
      .mockRejectedValueOnce(new Error('queue unavailable'))
      .mockResolvedValue(undefined);

    await expect(delivery.deliverToFollowers(actor, 'hello')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'federation.delivery.enqueue_failed' }), expect.any(String));
  });

  it('contains top-level outbox persistence failure and logs it', async () => {
    federation.insertActivity.mockRejectedValueOnce(new Error('db down'));
    await expect(delivery.deliverToFollowers(actor, 'hello')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ event: 'federation.outbox.deliver_failed' }), expect.any(String));
  });

  it('creates and persists Follow before delivering it', async () => {
    await delivery.sendFollowRequest(actor, 'https://remote.example/users/bob');
    expect(federation.insertApOutgoingFollow).toHaveBeenCalledWith(expect.objectContaining({ accepted: false, targetActorUrl: 'https://remote.example/users/bob' }));
    expect(fetchT).toHaveBeenCalled();
  });

  it.each([
    ['existing follow', { activityId: 'https://bridge.example/follow/original' }],
    ['missing follow', null],
  ])('sends Undo for %s and removes local outgoing-follow state', async (_label, record) => {
    federation.findApOutgoingFollowOne.mockResolvedValueOnce(record);
    await delivery.sendUnfollow(actor, 'https://remote.example/users/bob');
    expect(federation.removeApOutgoingFollow).toHaveBeenCalled();
    // Cagri kaydi artik TIPLIDIR; `as` yerine DOGRULAYAN daraltma kullanilir.
    const persisted = recordOf(federation.upsertDeliveryEntry.mock.calls[0][1], 'teslim kaydi');
    const body = recordOf(at(persisted, 'payload.activity', 'teslim kaydi'), 'aktivite');
    expect(body.type).toBe('Undo');
    if (record) expect(at(body, 'object.id', 'aktivite')).toBe(record.activityId);
    else expect(at(body, 'object.id', 'aktivite')).toBeUndefined();
  });

  it('persists Like and delivers the activity', async () => {
    const result = await delivery.sendLike(actor, 'https://remote.example/notes/1');
    expect(result.type).toBe('Like');
    expect(federation.insertApLike).toHaveBeenCalledWith(expect.objectContaining({ activityId: result.id, objectUrl: 'https://remote.example/notes/1' }));
  });

  it('persists Announce and delivers the activity', async () => {
    const result = await delivery.sendAnnounce(actor, 'https://remote.example/notes/1');
    expect(result.type).toBe('Announce');
    expect(federation.insertApAnnounce).toHaveBeenCalledWith(expect.objectContaining({ activityId: result.id, objectUrl: 'https://remote.example/notes/1' }));
  });
  it.each([0, 1, 2, 3, '2'])(
    'accepts canonical persisted delivery attempt count %p',
    (value) => expect(delivery.parseDeliveryAttempts(value)).toBe(Number(value)),
  );

  it.each([null, undefined, '', '-1', '1.5', '2x', -1, 1.5, NaN, Infinity, {}, []])(
    'rejects malformed persisted delivery attempt count %p',
    (value) => expect(() => delivery.parseDeliveryAttempts(value)).toThrow(/Invalid persisted ActivityPub delivery attempts/),
  );

});
