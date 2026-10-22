/**
 * P7 D2: application mapping of the PostgreSQL write barrier (migration 085).
 * The barrier itself is proven in pg-integration/channel-write-barrier.pgtest.ts.
 */
const log = { error: jest.fn(), info: jest.fn(), warn: jest.fn() };
jest.mock('../lib/logger', () => ({ __esModule: true, default: log, ...log }));

import { CHANNEL_WRITE_DENIED_SQLSTATE, isChannelWriteDenied } from '../lib/channelWriteBarrier';
import { isolateSocketHandler } from '../socket/handlerIsolation';
import { errorHandler } from '../middleware/errorHandler';

const denied = () => Object.assign(new Error('channel_unavailable'), { code: CHANNEL_WRITE_DENIED_SQLSTATE, detail: 'expired' });

beforeEach(() => jest.clearAllMocks());

describe('isChannelWriteDenied', () => {
  it('recognises only the barrier SQLSTATE', () => {
    expect(isChannelWriteDenied(denied())).toBe(true);
    expect(isChannelWriteDenied({ code: 'BX001' })).toBe(true);
    for (const other of [new Error('x'), { code: '23505' }, { code: '55P03' }, null, undefined, 'BX001', { code: 1 }]) {
      expect(isChannelWriteDenied(other)).toBe(false);
    }
  });
});

describe('socket handlers', () => {
  it('turn a barrier denial into the terminal CHANNEL_NOT_FOUND code with correlation ids', async () => {
    const socket = { emit: jest.fn() };
    await isolateSocketHandler(socket, 'message:send', async (_p: unknown) => { throw denied(); })(
      { ackId: 'ack-1', _tmpId: 'tmp-1', clientNonce: 'n-1' });
    expect(socket.emit).toHaveBeenCalledWith('error:message', {
      event: 'message:send', code: 'CHANNEL_NOT_FOUND', message: expect.any(String),
      ackId: 'ack-1', tmpId: 'tmp-1', clientNonce: 'n-1',
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it('keep the generic retryable answer for every other failure', async () => {
    const socket = { emit: jest.fn() };
    await isolateSocketHandler(socket, 'message:send', async (_p: unknown) => { throw new Error('db down'); })({ ackId: 'a' });
    const payload = socket.emit.mock.calls[0][1];
    expect(payload.code).toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });
});

describe('HTTP error handler', () => {
  const res = () => {
    const r = { headersSent: false, statusCode: 0, body: undefined as unknown, setHeader: jest.fn() } as unknown as {
      headersSent: boolean; statusCode: number; body: unknown; setHeader: jest.Mock;
      status: (code: number) => unknown; json: (body: unknown) => unknown;
    };
    r.status = (code: number) => { r.statusCode = code; return r; };
    r.json = (body: unknown) => { r.body = body; return r; };
    return r;
  };
  const req = { method: 'POST', originalUrl: '/api/x' };

  it('answers a barrier denial exactly like a missing channel, without detail', () => {
    const r = res();
    errorHandler(denied() as never, req as never, r as never, jest.fn());
    expect(r.statusCode).toBe(404);
    expect(r.body).toEqual({ error: 'Channel not found' });
    expect(JSON.stringify(r.body)).not.toMatch(/expired|BX001|tombstone/);
  });

  it('still answers 500 for unrelated errors', () => {
    const r = res();
    errorHandler(new Error('boom') as never, req as never, r as never, jest.fn());
    expect(r.statusCode).toBe(500);
  });
});
