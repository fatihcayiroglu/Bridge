const errorLog = jest.fn();
jest.mock('../lib/logger', () => ({ error: errorLog }));
import { isolateSocketHandler } from '../socket/handlerIsolation';

const socket = () => ({ emit: jest.fn() });

beforeEach(() => jest.clearAllMocks());

describe('socket handler isolation boundary', () => {
  it('preserves successful sync/async handlers without emitting a synthetic error', async () => {
    const s = socket();
    // `isolateSocketHandler<A>` A'yi HANDLER'in imzasindan cikarir. Parametresiz
    // ikizlerde A = [] oluyor ve sarmalayici argumansiz hale geliyordu; oysa
    // urun sarmalayiciya YUK gecer. Ikiz gercegi yazmali.
    const sync = jest.fn((_payload: unknown) => 1);
    const asyncFn = jest.fn(async (_payload: unknown) => 'ok');
    await isolateSocketHandler(s, 'x:sync', sync)({ x: 1 });
    await isolateSocketHandler(s, 'x:async', asyncFn)({ x: 2 });
    expect(sync).toHaveBeenCalled(); expect(asyncFn).toHaveBeenCalled();
    expect(s.emit).not.toHaveBeenCalled(); expect(errorLog).not.toHaveBeenCalled();
  });

  it.each<[string, (payload: unknown) => unknown]>([
    ['synchronous', (_payload: unknown) => { throw new Error('sync boom'); }],
    ['rejected', (_payload: unknown) => Promise.reject(new Error('async boom'))],
  ])('contains %s failures and returns correlation ids to the caller', async (_kind, fn) => {
    const s = socket();
    const wrapped = isolateSocketHandler(s, 'message:send', fn);
    await expect(wrapped({ ackId: 'ack-1', _tmpId: 'tmp-1' })).resolves.toBeUndefined();
    expect(errorLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'socket.message:send.failed', err: expect.any(Error) }), expect.any(String));
    expect(s.emit).toHaveBeenCalledWith('error:message', expect.objectContaining({ event: 'message:send', ackId: 'ack-1', tmpId: 'tmp-1' }));
  });

  it('does not reflect non-string correlation metadata into the error payload', async () => {
    const s = socket();
    await isolateSocketHandler(s, 'x', (_payload: unknown) => { throw new Error('boom'); })({ ackId: 7, _tmpId: {} });
    expect(s.emit).toHaveBeenCalledWith('error:message', { event: 'x', message: expect.any(String) });
  });
});
