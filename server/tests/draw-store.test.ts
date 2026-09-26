process.env.NODE_ENV = 'test';

const get = jest.fn(), set = jest.fn(), del = jest.fn(), withKeyLock = jest.fn();
let available = false;

jest.mock('../lib/redisAdapter', () => ({
  isRedisAvailable: () => available,
  cache: { get, set, del, withKeyLock, getAuthoritative:get, setAuthoritative:set, delAuthoritative:del },
}));
jest.mock('../lib/logger', () => ({ __esModule: true, default: { warn: jest.fn() } }));

import { drawStore, drawSessions } from '../socket/handlers/activities/draw-store';
import type { DrawSession } from '../socket/handlers/activities/draw-together';

function session(): DrawSession {
  return {
    sessionId: 'sess-1', channelId: 'ch-1', strokes: [], activeStrokes: new Map(),
    participants: new Map([['sock-a', { userId: 'u1', displayName: 'A', color: '#fff' }]]),
    createdAt: 123, hostSocketId: 'sock-a',
  };
}

describe('drawStore authoritative session contract', () => {
  beforeEach(() => {
    jest.clearAllMocks(); available = false; drawSessions.clear();
    withKeyLock.mockImplementation(async (_key: string, fn: () => Promise<unknown>) => fn());
  });

  it('single-node mode preserves Map-shaped session state locally', async () => {
    const s = session(); await drawStore.set('ch-1', s);
    expect(await drawStore.get('ch-1')).toBe(s);
    await drawStore.del('ch-1'); expect(await drawStore.get('ch-1')).toBeNull();
  });

  it('Redis mode serializes Maps and reconstructs them on read', async () => {
    available = true;
    const s = session();
    await drawStore.set('ch-1', s);
    const persisted = set.mock.calls[0][1];
    expect(persisted.participants).toEqual([{ socketId: 'sock-a', userId: 'u1', displayName: 'A', color: '#fff' }]);
    get.mockResolvedValueOnce(persisted);
    const restored = await drawStore.get('ch-1');
    expect(restored?.participants.get('sock-a')?.userId).toBe('u1');
    expect(restored?.activeStrokes).toBeInstanceOf(Map);
  });

  it('corrupt Redis session is rejected rather than reset to an empty canvas', async () => {
    available = true; get.mockResolvedValueOnce({ channelId: 'ch-1', strokes: [] });
    await expect(drawStore.get('ch-1')).rejects.toThrow(/Invalid persisted draw session/);
    expect(drawSessions.size).toBe(0);
  });

  it('mutations use the shared distributed lock owner', async () => {
    await drawStore.withLock('ch-1', async () => 7);
    expect(withKeyLock).toHaveBeenCalledWith('draw-session:ch-1', expect.any(Function), expect.objectContaining({ leaseSeconds: 5 }));
  });
});
