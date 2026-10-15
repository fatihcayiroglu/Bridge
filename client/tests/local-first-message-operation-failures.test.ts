// client/tests/local-first-message-operation-failures.test.ts
//
// The non-send mutation replay owner (edit / delete / reaction) keeps every
// operation in the encrypted local operation log until the server answers.
// The existing suites drive the happy paths, socket loss and server verdicts.
// This suite drives what happens when the session or the local store fails
// in the middle of an operation:
//   - a logout while an operation is being marked "sending" emits NOTHING on
//     the socket (no mutation leaks into the next session's connection);
//   - a logout while a replay walks its snapshot stops the walk;
//   - a server ACK or rejection that cannot be recorded locally produces no
//     "applied"/"rejected" event and leaves the operation replayable;
//   - an ACK timeout that cannot be recorded is logged, not thrown;
//   - socket loss or reconnect recovery that cannot re-queue one operation
//     still re-queues the others;
//   - an ACK that arrives after getMe() has gone quiet is still attributed to
//     the account that queued it; with no account at all it is ignored.
//
// Storage failures are injected by wrapping the REAL operation-runtime
// functions: every call still goes to the real encrypted log unless a test
// makes one specific call fail.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({ failNext: new Map<string, number>() }));
vi.mock('../js/core/local-first/operation-runtime.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../js/core/local-first/operation-runtime.ts')>();
  const wrap = <F extends (...args: never[]) => Promise<unknown>>(name: string, fn: F) =>
    vi.fn(async (...args: Parameters<F>) => {
      const remaining = runtime.failNext.get(name) ?? 0;
      if (remaining > 0) {
        runtime.failNext.set(name, remaining - 1);
        throw new Error(`injected ${name} failure`);
      }
      return fn(...args);
    });
  return {
    ...real,
    transitionLocalFirstOperation: wrap('transition', real.transitionLocalFirstOperation),
    compactLocalFirstOperations: wrap('compact', real.compactLocalFirstOperations),
    getLocalFirstOperation: wrap('get', real.getLocalFirstOperation),
    listActiveLocalFirstOperations: wrap('list', real.listActiveLocalFirstOperations),
  };
});
const logged = vi.hoisted(() => ({ warn: [] as unknown[][] }));
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), error: vi.fn(), warn: (...args: unknown[]) => { logged.warn.push(args); } }),
}));

import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import * as operationRuntime from '../js/core/local-first/operation-runtime.ts';
import {
  closeMessageOperationSync,
  handleMessageOperationSocketDisconnected,
  MESSAGE_OPERATION_ACK_TIMEOUT_MS,
  queueDeleteMessageOperation,
  queueReactionMessageOperation,
  rejectMessageOperation,
  replayMessageOperations,
  resetMessageOperationSyncForTests,
  resolveMessageOperation,
} from '../js/core/local-first/message-operation-sync.ts';

const { getLocalFirstOperation } = operationRuntime;
let socket: { emit: ReturnType<typeof vi.fn> };
let connected: boolean;
let me: { _id: string } | null;
const events: Array<{ type: string; opId: unknown }> = [];
const TYPES = ['queued', 'dispatched', 'timeout', 'applied', 'rejected'].map(s => `bridge:message-operation-${s}`);
const record = (e: Event) => events.push({ type: e.type.replace('bridge:message-operation-', ''), opId: (e as CustomEvent).detail.opId });
const fail = (name: 'transition' | 'get' | 'list' | 'compact', times = 1) => runtime.failNext.set(name, times);
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise(r => setTimeout(r, 0)); };

beforeEach(() => {
  resetMessageOperationSyncForTests();
  runtime.failNext.clear();
  vi.mocked(operationRuntime.transitionLocalFirstOperation).mockClear();
  vi.mocked(operationRuntime.getLocalFirstOperation).mockClear();
  vi.mocked(operationRuntime.listActiveLocalFirstOperations).mockClear();
  vi.mocked(operationRuntime.compactLocalFirstOperations).mockClear();
  logged.warn.length = 0;
  socket = { emit: vi.fn() };
  connected = true;
  me = { _id: 'u1' };
  events.length = 0;
  for (const type of TYPES) document.addEventListener(type, record);
  BridgeRegistry.register('getMe', (() => me) as AnyFn);
  BridgeRegistry.register('getSocketConnected', (() => connected) as AnyFn);
  BridgeRegistry.register('socket', socket as unknown as AnyFn);
});

afterEach(() => {
  vi.useRealTimers();
  for (const type of TYPES) document.removeEventListener(type, record);
  resetMessageOperationSyncForTests();
  BridgeRegistry.unregister('getMe');
  BridgeRegistry.unregister('getSocketConnected');
  BridgeRegistry.unregister('socket');
});

describe('a session that ends mid-operation emits nothing', () => {
  it('logout while the operation is being marked "sending": nothing reaches the socket', async () => {
    const transition = vi.mocked(operationRuntime.transitionLocalFirstOperation);
    const real = transition.getMockImplementation()!;
    transition.mockImplementationOnce(async (...args) => {
      const result = await real(...args);
      closeMessageOperationSync(); // the person signs out while the write is in flight
      return result;
    });

    const queued = await queueDeleteMessageOperation({ opId: 'del-logout', channelId: 'c1', messageId: 'm1' });
    expect(queued.dispatched).toBe(false);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(events.filter(e => e.type === 'dispatched')).toEqual([]);
  });

  it('logout while a reconnect replay walks its snapshot stops the walk', async () => {
    connected = false;
    await queueDeleteMessageOperation({ opId: 'walk-1', channelId: 'c1', messageId: 'm1' });
    await queueDeleteMessageOperation({ opId: 'walk-2', channelId: 'c1', messageId: 'm2' });
    connected = true;

    const list = vi.mocked(operationRuntime.listActiveLocalFirstOperations);
    const real = list.getMockImplementation()!;
    list.mockImplementationOnce(async (...args) => {
      const rows = await real(...args);
      closeMessageOperationSync();
      return rows;
    });
    await replayMessageOperations(false);
    expect(socket.emit).not.toHaveBeenCalled();
  });
  it('logout during the first of two replayed operations: neither is emitted', async () => {
    connected = false;
    await queueDeleteMessageOperation({ opId: 'pair-1', channelId: 'c1', messageId: 'm1' });
    await queueDeleteMessageOperation({ opId: 'pair-2', channelId: 'c1', messageId: 'm2' });
    connected = true;

    const transition = vi.mocked(operationRuntime.transitionLocalFirstOperation);
    const real = transition.getMockImplementation()!;
    transition.mockImplementationOnce(async (...args) => {
      const result = await real(...args);
      closeMessageOperationSync();
      return result;
    });
    await replayMessageOperations(false);
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('the socket drops while a replay walks its snapshot: nothing is emitted and the rows stay queued', async () => {
    connected = false;
    await queueDeleteMessageOperation({ opId: 'drop-1', channelId: 'c1', messageId: 'm1' });
    connected = true;

    const list = vi.mocked(operationRuntime.listActiveLocalFirstOperations);
    const real = list.getMockImplementation()!;
    list.mockImplementationOnce(async (...args) => {
      const rows = await real(...args);
      connected = false;
      return rows;
    });
    await replayMessageOperations(false);
    expect(socket.emit).not.toHaveBeenCalled();
    await expect(getLocalFirstOperation('u1', 'drop-1')).resolves.toMatchObject({ state: 'queued', attempts: 0 });
  });
});

describe('a server verdict that cannot be recorded locally', () => {
  it('an ACK that cannot be written raises no "applied" event and the operation stays replayable', async () => {
    await queueDeleteMessageOperation({ opId: 'ack-fail', channelId: 'c1', messageId: 'm1' });
    fail('transition');
    await resolveMessageOperation('ack-fail');
    await settle();

    expect(events.filter(e => e.type === 'applied')).toEqual([]);
    await expect(getLocalFirstOperation('u1', 'ack-fail')).resolves.toMatchObject({ state: 'sending' });
    expect(logged.warn.some(args => String(args[0]).includes('applied'))).toBe(true);

    // The recorded state is still "sending": a reconnect replays the same nonce.
    socket.emit.mockClear();
    await replayMessageOperations(true);
    expect(socket.emit).toHaveBeenCalledWith('message:delete', expect.objectContaining({ clientNonce: 'ack-fail' }));
  });

  it('an ACK whose row cannot be read is ignored, not applied', async () => {
    await queueDeleteMessageOperation({ opId: 'ack-unreadable', channelId: 'c1', messageId: 'm1' });
    fail('get');
    await resolveMessageOperation('ack-unreadable');
    expect(events.filter(e => e.type === 'applied')).toEqual([]);
    await expect(getLocalFirstOperation('u1', 'ack-unreadable')).resolves.toMatchObject({ state: 'sending' });
  });

  it('a rejection that cannot be written raises no "rejected" event; one whose row cannot be read is ignored', async () => {
    await queueDeleteMessageOperation({ opId: 'rej-fail', channelId: 'c1', messageId: 'm1' });
    fail('transition');
    await rejectMessageOperation('rej-fail', 'FORBIDDEN');
    fail('get');
    await rejectMessageOperation('rej-fail', 'FORBIDDEN');
    await settle();

    expect(events.filter(e => e.type === 'rejected')).toEqual([]);
    await expect(getLocalFirstOperation('u1', 'rej-fail')).resolves.toMatchObject({ state: 'sending' });
    expect(logged.warn.some(args => String(args[0]).includes('rejected'))).toBe(true);
  });

  it('an ACK timeout that cannot be recorded is logged, raises no timeout event and throws nothing', async () => {
    vi.useFakeTimers();
    await queueDeleteMessageOperation({ opId: 'timeout-fail', channelId: 'c1', messageId: 'm1' });
    fail('transition');
    await vi.advanceTimersByTimeAsync(MESSAGE_OPERATION_ACK_TIMEOUT_MS);
    expect(events.filter(e => e.type === 'timeout')).toEqual([]);
    expect(logged.warn.some(args => String(args[0]).includes('timeout'))).toBe(true);
  });
});

describe('re-queueing one operation fails, the others are still re-queued', () => {
  it('socket loss', async () => {
    await queueDeleteMessageOperation({ opId: 'loss-1', channelId: 'c1', messageId: 'm1' });
    await queueReactionMessageOperation({ opId: 'loss-2', channelId: 'c1', messageId: 'm2', emoji: '👍', desired: true });
    fail('transition');
    await handleMessageOperationSocketDisconnected();

    const states = [
      (await getLocalFirstOperation('u1', 'loss-1'))?.state,
      (await getLocalFirstOperation('u1', 'loss-2'))?.state,
    ];
    expect(states.sort()).toEqual(['queued', 'sending']);
    expect(events.filter(e => e.type === 'queued')).toHaveLength(1);
    expect(logged.warn.some(args => String(args[0]).includes('Disconnect'))).toBe(true);
  });

  it('reconnect recovery', async () => {
    await queueDeleteMessageOperation({ opId: 'rec-1', channelId: 'c1', messageId: 'm1' });
    await queueDeleteMessageOperation({ opId: 'rec-2', channelId: 'c1', messageId: 'm2' });
    socket.emit.mockClear();
    events.length = 0;
    fail('transition');
    await replayMessageOperations(true);

    // One row could not be moved back to queued, so it was not re-sent; the
    // other was re-queued and re-sent with its original nonce.
    const nonces = socket.emit.mock.calls.map(call => (call[1] as { clientNonce: string }).clientNonce);
    expect(nonces).toHaveLength(1);
    expect(['rec-1', 'rec-2']).toContain(nonces[0]);
    expect(events.filter(e => e.type === 'queued')).toHaveLength(1);
    expect(logged.warn.some(args => String(args[0]).includes('kuyruğa'))).toBe(true);
  });
});

describe('a re-queue that cannot be written leaves the operation in "sending", never lost', () => {
  it('socket gone between the "sending" write and the emit', async () => {
    const transition = vi.mocked(operationRuntime.transitionLocalFirstOperation);
    const real = transition.getMockImplementation()!;
    transition.mockImplementationOnce(async (...args) => {
      const result = await real(...args);
      connected = false;               // the connection drops right after the write
      runtime.failNext.set('transition', 1); // and the re-queue write fails
      return result;
    });
    const queued = await queueDeleteMessageOperation({ opId: 'gone-1', channelId: 'c1', messageId: 'm1' });
    expect(queued.dispatched).toBe(false);
    expect(socket.emit).not.toHaveBeenCalled();
    expect(events.filter(e => e.type === 'queued')).toEqual([]);
    // Still "sending": the next reconnect recovery re-queues and re-sends it.
    await expect(getLocalFirstOperation('u1', 'gone-1')).resolves.toMatchObject({ state: 'sending' });
    connected = true;
    await replayMessageOperations(true);
    expect(socket.emit).toHaveBeenCalledWith('message:delete', expect.objectContaining({ clientNonce: 'gone-1' }));
  });

  it('emit throws and the re-queue write fails', async () => {
    socket.emit.mockImplementationOnce(() => { runtime.failNext.set('transition', 1); throw new Error('socket closed'); });
    const queued = await queueDeleteMessageOperation({ opId: 'throw-1', channelId: 'c1', messageId: 'm1' });
    expect(queued.dispatched).toBe(false);
    expect(events.filter(e => e.type === 'queued' || e.type === 'dispatched')).toEqual([]);
    await expect(getLocalFirstOperation('u1', 'throw-1')).resolves.toMatchObject({ state: 'sending' });
  });

  it('socket loss when the log cannot be listed re-queues nothing and throws nothing', async () => {
    await queueDeleteMessageOperation({ opId: 'nolist-1', channelId: 'c1', messageId: 'm1' });
    fail('list');
    await expect(handleMessageOperationSocketDisconnected()).resolves.toBeUndefined();
    expect(events.filter(e => e.type === 'queued')).toEqual([]);
  });

  it('a compaction failure after an ACK or a rejection does not undo the recorded verdict', async () => {
    await queueDeleteMessageOperation({ opId: 'cmp-ack', channelId: 'c1', messageId: 'm1' });
    await queueDeleteMessageOperation({ opId: 'cmp-rej', channelId: 'c1', messageId: 'm2' });
    fail('compact', 2);
    await resolveMessageOperation('cmp-ack');
    await rejectMessageOperation('cmp-rej', 'FORBIDDEN');
    await settle();
    expect(events.filter(e => e.type === 'applied' || e.type === 'rejected').map(e => [e.type, e.opId]))
      .toEqual([['applied', 'cmp-ack'], ['rejected', 'cmp-rej']]);
    expect(vi.mocked(operationRuntime.compactLocalFirstOperations)).toHaveBeenCalledTimes(2);
  });
});

describe('socket loss and operation ids', () => {
  it('socket loss re-queues only in-flight rows; a row waiting behind it is left exactly as it was', async () => {
    // Desired-state reactions on one message+emoji are serialized: the second
    // waits in "queued" while the first is in flight.
    await queueReactionMessageOperation({ opId: 'react-on', channelId: 'c1', messageId: 'm1', emoji: '👍', desired: true });
    await queueReactionMessageOperation({ opId: 'react-off', channelId: 'c1', messageId: 'm1', emoji: '👍', desired: false });
    await expect(getLocalFirstOperation('u1', 'react-off')).resolves.toMatchObject({ state: 'queued', attempts: 0 });
    events.length = 0;
    await handleMessageOperationSocketDisconnected();
    expect(events).toEqual([{ type: 'queued', opId: 'react-on' }]);
    const waiting = await getLocalFirstOperation('u1', 'react-off');
    expect(waiting).toMatchObject({ state: 'queued', attempts: 0 });
    expect(waiting?.lastError).not.toBe('socket-disconnected');
  });

  it('without crypto.randomUUID, ids made in the same millisecond are still distinct and stable through replay', async () => {
    const original = globalThis.crypto.randomUUID;
    Object.defineProperty(globalThis.crypto, 'randomUUID', { value: undefined, configurable: true });
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_760_000_000_000);
    try {
      connected = false;
      const a = await queueDeleteMessageOperation({ channelId: 'c1', messageId: 'm1' });
      const b = await queueDeleteMessageOperation({ channelId: 'c1', messageId: 'm2' });
      now.mockRestore();
      expect(a.opId).toMatch(/^op-1760000000000-[a-z0-9]+$/);
      expect(b.opId).not.toBe(a.opId);
      connected = true;
      await replayMessageOperations(false);
      expect(socket.emit.mock.calls.map(call => (call[1] as { clientNonce: string }).clientNonce).sort())
        .toEqual([a.opId, b.opId].sort());
    } finally {
      now.mockRestore();
      Object.defineProperty(globalThis.crypto, 'randomUUID', { value: original, configurable: true });
    }
  });
});

describe('which account a late server answer belongs to', () => {
  it('an ACK arriving after getMe() went quiet is applied to the account that queued it', async () => {
    await queueDeleteMessageOperation({ opId: 'late-ack', channelId: 'c1', messageId: 'm1' });
    me = null;
    await resolveMessageOperation('late-ack');
    expect(events.filter(e => e.type === 'applied').map(e => e.opId)).toEqual(['late-ack']);
    await expect(getLocalFirstOperation('u1', 'late-ack')).resolves.toMatchObject({ state: 'applied' });
  });

  it('with no account at all, an ACK, a rejection and a socket loss are ignored', async () => {
    me = null;
    await resolveMessageOperation('orphan-op');
    await rejectMessageOperation('orphan-op', 'X');
    await handleMessageOperationSocketDisconnected();
    expect(events).toEqual([]);
    expect(vi.mocked(operationRuntime.getLocalFirstOperation)).not.toHaveBeenCalled();
    expect(vi.mocked(operationRuntime.listActiveLocalFirstOperations)).not.toHaveBeenCalled();
  });
});
