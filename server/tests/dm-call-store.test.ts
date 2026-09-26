process.env.NODE_ENV = 'test';

import { dmCallStore } from '../socket/handlers/dm-call-store';
import { cache } from '../lib/redisAdapter';

const call = (id = 'c1') => ({
  callId: id,
  callerId: 'u1',
  calleeId: 'u2',
  type: 'voice' as const,
  startedAt: 1000,
  status: 'ringing' as const,
});

describe('DM call authoritative store', () => {
  beforeEach(async () => {
    dmCallStore._localCalls_TEST_ONLY.clear();
    await cache.del('dm:call:c1').catch(() => undefined);
  });

  it('round-trips and deletes call metadata in single-node fallback', async () => {
    await dmCallStore.set(call());
    await expect(dmCallStore.get('c1')).resolves.toEqual(call());
    await dmCallStore.del('c1');
    await expect(dmCallStore.get('c1')).resolves.toBeNull();
  });

  it('rejects malformed persisted participant/state metadata fail-closed', async () => {
    dmCallStore._localCalls_TEST_ONLY.set('c1', { ...call(), calleeId: 'u1' } as any);
    await expect(dmCallStore.get('c1')).rejects.toThrow(/Invalid persisted DM call/);
  });

  it('serializes same-call mutations through the canonical distributed lock', async () => {
    const order: string[] = [];
    await Promise.all([
      dmCallStore.withLock('c1', async () => { order.push('a1'); await new Promise(r => setTimeout(r, 5)); order.push('a2'); }),
      dmCallStore.withLock('c1', async () => { order.push('b1'); order.push('b2'); }),
    ]);
    expect(order).toEqual(['a1', 'a2', 'b1', 'b2']);
  });
});
