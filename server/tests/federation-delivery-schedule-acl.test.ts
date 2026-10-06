// server/tests/federation-delivery-schedule-acl.test.ts
//
// P5 FED-05 / FED-06 — both measured in the two-instance federation lab.
//
//   FED-06  The retry schedule was 30 s, 2 min, 10 min: a remote that was down
//           for ~15 minutes (an upgrade, a reboot) never received what was
//           posted meanwhile. The DEFAULT schedule is asserted here; the ceiling
//           mechanics are covered by federation-delivery-queue-worker.test.ts.
//   FED-05  The domain ACL guarded inbound traffic only. A blocked domain still
//           received every post/follow/like, and its actor documents were
//           still fetched to resolve inboxes.

'use strict';
export {};

process.env.NODE_ENV = 'test';
delete process.env.FEDERATION_DELIVERY_RETRY_DELAYS_MS; // the shipped default
process.env.INSTANCE_URL = 'https://bridge.test';

const fetchT = jest.fn();
const warn = jest.fn();
const error = jest.fn();
const info = jest.fn();
const federation = {
  claimPendingDeliveries: jest.fn(async () => [] as Array<Record<string, unknown>>),
  removeDeliveryEntry: jest.fn(async () => undefined),
  findBlacklist: jest.fn(async (): Promise<unknown[]> => []),
  findWhitelist: jest.fn(async (): Promise<unknown[]> => []),
  releaseDeliveryClaim: jest.fn<Promise<unknown>, [id: string, claimOwner: string, doc: Record<string, unknown>]>(async () => undefined),
  upsertDeliveryEntry: jest.fn(async () => undefined),
  findApFollows: jest.fn(async () => [] as unknown),
};
const users = { getApPrivateKey: jest.fn(async () => null) };

jest.mock('../lib/fetch', () => ({ fetchT: (...args: unknown[]) => fetchT(...args) }));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { warn, info, error } }));
jest.mock('../db/repositories', () => ({ Federation: federation, Users: users }));

const realSetInterval = global.setInterval;
const realSetImmediate = global.setImmediate;
let workerTick: (() => unknown) | null = null;
jest.spyOn(global, 'setInterval').mockImplementation(((fn: any, ms: any) => {
  if (ms === 30_000) workerTick = fn;
  return realSetInterval(() => undefined, 2 ** 30);
}) as never);
jest.spyOn(global, 'setImmediate').mockImplementation((() => realSetImmediate(() => undefined)) as never);

const delivery = require('../routes/federation/delivery');
delivery.startFederationDeliveryWorker();

const ok = () => ({ ok: true, status: 200, json: async () => ({}) });
const fail = (status: number) => ({ ok: false, status, json: async () => ({}) });
const entry = (inboxUrl: string, attempts = 1) => ({
  _id: 'q1', attempts, nextAt: 0, payload: { inboxUrl, activity: { type: 'Create', id: 'act-1' }, fromUser: null },
});

beforeEach(() => {
  jest.clearAllMocks();
  fetchT.mockResolvedValue(ok());
  federation.findBlacklist.mockResolvedValue([]);
  federation.findWhitelist.mockResolvedValue([]);
});

describe('FED-06: the retry schedule outlives an ordinary outage', () => {
  const { DEFAULT_RETRY_DELAYS_MS, parseRetrySchedule } = delivery;

  it('the default spans more than 3 days, backing off monotonically', () => {
    const total = DEFAULT_RETRY_DELAYS_MS.reduce((a: number, b: number) => a + b, 0);
    expect(total).toBeGreaterThan(3 * 86_400_000);
    for (let i = 1; i < DEFAULT_RETRY_DELAYS_MS.length; i++) {
      expect(DEFAULT_RETRY_DELAYS_MS[i]).toBeGreaterThanOrEqual(DEFAULT_RETRY_DELAYS_MS[i - 1]);
    }
  });

  it('a row past the OLD ceiling (3 attempts, ~12.5 min) is re-queued, not dropped', async () => {
    fetchT.mockResolvedValue(fail(503));
    federation.claimPendingDeliveries.mockResolvedValue([entry('https://remote.test/inbox', 3)]);
    const now = 1_800_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now);
    try { await workerTick!(); } finally { clock.mockRestore(); }

    expect(federation.removeDeliveryEntry).not.toHaveBeenCalled();
    const doc = federation.releaseDeliveryClaim.mock.calls[0]![2];
    expect(doc.attempts).toBe(4);
    expect(doc.nextAt).toBe(now + DEFAULT_RETRY_DELAYS_MS[4]);
  });

  it('the last default attempt dead-letters loudly (error level, no content)', async () => {
    fetchT.mockResolvedValue(fail(503));
    federation.claimPendingDeliveries.mockResolvedValue([entry('https://remote.test/inbox', DEFAULT_RETRY_DELAYS_MS.length - 1)]);
    await workerTick!();

    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('q1', expect.any(String));
    const [fields] = error.mock.calls.find(([f]) => f?.event === 'federation.delivery.max_retries')!;
    expect(fields).toMatchObject({ inboxHost: 'remote.test', activityType: 'Create', activityId: 'act-1' });
    expect(JSON.stringify(fields)).not.toContain('content');
  });

  it.each([
    ['', DEFAULT_RETRY_DELAYS_MS],
    ['1000,5000', [1000, 5000]],
  ])('parses %j', (raw, expected) => {
    expect(parseRetrySchedule(raw)).toEqual([...expected]);
  });

  it.each([['abc'], ['1000,,2000'], ['500'], ['-1000'], ['1000,999999999999']])('refuses %j loudly and keeps the default', (raw) => {
    expect(parseRetrySchedule(raw)).toEqual([...DEFAULT_RETRY_DELAYS_MS]);
    expect(error).toHaveBeenCalledWith(expect.objectContaining({ event: 'federation.delivery.invalid_retry_schedule' }), expect.any(String));
  });
});

describe('FED-05: outbound delivery honours the domain ACL', () => {
  it('positive control: an allowed domain is delivered', async () => {
    federation.claimPendingDeliveries.mockResolvedValue([entry('https://remote.test/inbox')]);
    await workerTick!();
    expect(fetchT).toHaveBeenCalledTimes(1);
  });

  it('a blacklisted domain gets nothing — not even an actor-document fetch', async () => {
    federation.findBlacklist.mockResolvedValue([{ _id: 'b', domain: 'evil.test', reason: '', createdAt: 1 }]);
    federation.claimPendingDeliveries.mockResolvedValue([entry('https://evil.test/users/mallory')]);
    await workerTick!();

    expect(fetchT).not.toHaveBeenCalled();
    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('q1', expect.any(String));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: 'federation.delivery.blocked_by_acl', host: 'evil.test' }), expect.any(String));
  });

  it('a wildcard block covers subdomains', async () => {
    federation.findBlacklist.mockResolvedValue([{ _id: 'b', domain: '*.evil.test', reason: '', createdAt: 1 }]);
    federation.claimPendingDeliveries.mockResolvedValue([entry('https://inbox.evil.test/inbox')]);
    await workerTick!();
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('allowlist mode: a domain not on the list gets nothing', async () => {
    federation.findWhitelist.mockResolvedValue([{ _id: 'w', domain: 'friend.test', reason: '', createdAt: 1 }]);
    federation.claimPendingDeliveries.mockResolvedValue([entry('https://stranger.test/inbox')]);
    await workerTick!();
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('an actor on an allowed domain whose inbox lives on a blocked one gets nothing', async () => {
    federation.findBlacklist.mockResolvedValue([{ _id: 'b', domain: 'evil.test', reason: '', createdAt: 1 }]);
    fetchT.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'https://front.test/users/x', inbox: 'https://evil.test/inbox' }),
    });
    federation.claimPendingDeliveries.mockResolvedValue([entry('https://front.test/users/x')]);
    await workerTick!();

    // Exactly one call: the actor document. No POST to the blocked inbox.
    expect(fetchT).toHaveBeenCalledTimes(1);
    expect(fetchT.mock.calls[0]![0]).toBe('https://front.test/users/x');
    expect(federation.removeDeliveryEntry).toHaveBeenCalledWith('q1', expect.any(String));
  });

  it('an unavailable ACL store never becomes "allow": the row stays queued', async () => {
    federation.findBlacklist.mockRejectedValue(new Error('db down'));
    federation.claimPendingDeliveries.mockResolvedValue([entry('https://remote.test/inbox')]);
    await workerTick!();

    expect(fetchT).not.toHaveBeenCalled();
    expect(federation.removeDeliveryEntry).not.toHaveBeenCalled();
    expect(federation.releaseDeliveryClaim).toHaveBeenCalledWith('q1', expect.any(String), expect.objectContaining({ attempts: 2 }));
  });
});

describe('FED-08: a follow target is resolved before anything is stored', () => {
  const { resolveFollowTarget } = delivery;
  const actor = (doc: Record<string, unknown>) => ({ ok: true, status: 200, json: async () => doc });

  it('positive control: an actor document with an inbox is followable', async () => {
    fetchT.mockResolvedValueOnce(actor({ id: 'https://remote.test/users/x', inbox: 'https://remote.test/users/x/inbox' }));
    await expect(resolveFollowTarget('https://remote.test/users/x')).resolves.toEqual({ ok: true });
  });

  it('an address the SSRF guard refuses is unresolvable — and the reason is not echoed', async () => {
    fetchT.mockRejectedValueOnce(new Error('SSRF: 127.0.0.1 is a private address'));
    const verdict = await resolveFollowTarget('https://canary.test/users/x');
    expect(verdict).toEqual({ ok: false, status: 422, error: 'Remote actor could not be resolved' });
    expect(JSON.stringify(verdict)).not.toContain('127.0.0.1');
  });

  it.each([
    ['a non-2xx answer', { ok: false, status: 404, json: async () => ({}) }],
    ['a document without an inbox (not an actor)', { ok: true, status: 200, json: async () => ({ type: 'Note' }) }],
    ['a non-http inbox', { ok: true, status: 200, json: async () => ({ inbox: 'file:///etc/passwd' }) }],
  ])('%s is unresolvable', async (_label, response) => {
    fetchT.mockResolvedValueOnce(response);
    await expect(resolveFollowTarget('https://remote.test/users/x')).resolves.toMatchObject({ ok: false, status: 422 });
  });

  it('a blocked domain is refused without fetching anything', async () => {
    federation.findBlacklist.mockResolvedValue([{ _id: 'b', domain: 'evil.test', reason: '', createdAt: 1 }]);
    await expect(resolveFollowTarget('https://evil.test/users/m')).resolves.toMatchObject({ ok: false, status: 403 });
    expect(fetchT).not.toHaveBeenCalled();
  });

  it('an allowed actor whose inbox is on a blocked domain is refused', async () => {
    federation.findBlacklist.mockResolvedValue([{ _id: 'b', domain: 'evil.test', reason: '', createdAt: 1 }]);
    fetchT.mockResolvedValueOnce(actor({ inbox: 'https://evil.test/inbox' }));
    await expect(resolveFollowTarget('https://front.test/users/x')).resolves.toMatchObject({ ok: false, status: 403 });
  });

  it('an unanswerable ACL is a 503, not an allow', async () => {
    federation.findBlacklist.mockRejectedValue(new Error('db down'));
    await expect(resolveFollowTarget('https://remote.test/users/x')).resolves.toMatchObject({ ok: false, status: 503 });
    expect(fetchT).not.toHaveBeenCalled();
  });
});

describe('FED-09: a hanging remote does not hold the request', () => {
  it('returns after a bounded wait with the durable row written; the attempt finishes in the background', async () => {
    let release!: (v: unknown) => void;
    fetchT.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const t0 = Date.now();
    await delivery.deliverApActivity('https://slow.test/inbox', { type: 'Create', id: 'slow-1' }, null);
    const waited = Date.now() - t0;

    expect(waited).toBeGreaterThanOrEqual(1_400);
    expect(waited).toBeLessThan(3_000);
    expect(federation.upsertDeliveryEntry).toHaveBeenCalledTimes(1);   // durable intent first
    expect(federation.removeDeliveryEntry).not.toHaveBeenCalled();     // not acknowledged yet

    release({ ok: true, status: 200, json: async () => ({}) });
    await new Promise((r) => setTimeout(r, 50));
    expect(federation.removeDeliveryEntry).toHaveBeenCalledTimes(1);  // acknowledged once it lands
  });

  it('a fast remote is still awaited in full (unchanged behaviour)', async () => {
    const t0 = Date.now();
    await delivery.deliverApActivity('https://fast.test/inbox', { type: 'Create', id: 'fast-1' }, null);
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(federation.removeDeliveryEntry).toHaveBeenCalledTimes(1);
  });
});
