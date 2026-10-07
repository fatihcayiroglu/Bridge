// P7 A5/A7 — lifecycle of the single non-send mutation replay owner across
// socket loss, logout and server verdicts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import {
  closeMessageOperationSync,
  handleMessageOperationSocketDisconnected,
  MESSAGE_OPERATION_ACK_TIMEOUT_MS,
  queueDeleteMessageOperation,
  queueEditMessageOperation,
  rejectMessageOperation,
  replayMessageOperations,
  resetMessageOperationSyncForTests,
  resolveMessageOperation,
} from '../js/core/local-first/message-operation-sync.ts';
import { getLocalFirstOperation } from '../js/core/local-first/operation-runtime.ts';

let socket: { emit: ReturnType<typeof vi.fn> };
let connected: () => boolean;
const events: Array<{ type: string; detail: Record<string, unknown> }> = [];
const TYPES = ['queued', 'dispatched', 'timeout', 'applied', 'rejected'].map(s => `bridge:message-operation-${s}`);
const record = (e: Event) => events.push({ type: e.type, detail: (e as CustomEvent).detail });

beforeEach(() => {
  resetMessageOperationSyncForTests();
  socket = { emit: vi.fn() };
  connected = () => true;
  events.length = 0;
  for (const type of TYPES) document.addEventListener(type, record);
  BridgeRegistry.register('getMe', (() => ({ id: 'u1' })) as AnyFn); // `id`, not `_id`
  BridgeRegistry.register('getSocketConnected', (() => connected()) as AnyFn);
  BridgeRegistry.register('socket', socket as unknown as AnyFn);
});

afterEach(() => {
  vi.useRealTimers();
  for (const type of TYPES) document.removeEventListener(type, record);
  resetMessageOperationSyncForTests();
  BridgeRegistry.unregister('getMe');
  BridgeRegistry.unregister('getSocketConnected');
  BridgeRegistry.unregister('socket');
  vi.restoreAllMocks();
});

describe('P7 mutation replay owner lifecycle', () => {
  it('socket loss re-queues in-flight mutations and the reconnect replays the SAME nonce once', async () => {
    await queueDeleteMessageOperation({ opId: 'd1', channelId: 'c1', messageId: 'm1' });
    expect(socket.emit).toHaveBeenCalledTimes(1);

    await handleMessageOperationSocketDisconnected();
    await expect(getLocalFirstOperation('u1', 'd1')).resolves.toMatchObject({
      state: 'queued', attempts: 1, lastError: 'socket-disconnected',
    });
    expect(events.filter(e => e.type.endsWith('queued')).map(e => e.detail.opId)).toEqual(['d1']);

    socket.emit.mockClear();
    await replayMessageOperations(true);
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenCalledWith('message:delete', { messageId: 'm1', channelId: 'c1', clientNonce: 'd1' });
    await expect(getLocalFirstOperation('u1', 'd1')).resolves.toMatchObject({ state: 'sending', attempts: 2 });
  });

  it('a socket that drops between persistence and emit leaves the row queued, never "sent"', async () => {
    // Connected for the replay walk and the pre-transition check; gone by the
    // time the owner re-checks right before emitting.
    let calls = 0;
    connected = () => { calls += 1; return calls <= 2; };

    const queued = await queueDeleteMessageOperation({ opId: 'race', channelId: 'c1', messageId: 'm1' });

    expect(queued.dispatched).toBe(false);
    expect(socket.emit).not.toHaveBeenCalled();
    await expect(getLocalFirstOperation('u1', 'race')).resolves.toMatchObject({
      state: 'queued', attempts: 1, lastError: 'disconnected-before-emit',
    });
  });

  it('logout cancels pending ACK timers: a late timeout cannot write for the closed session', async () => {
    vi.useFakeTimers();
    await queueEditMessageOperation({ opId: 'e1', channelId: 'c1', messageId: 'm1', content: 'new text', baseVersion: 3 });
    closeMessageOperationSync();
    await vi.advanceTimersByTimeAsync(MESSAGE_OPERATION_ACK_TIMEOUT_MS + 1_000);
    expect(events.some(e => e.type.endsWith('timeout'))).toBe(false);
  });

  it('a server rejection is terminal and carries the server code (default MUTATION_REJECTED)', async () => {
    await queueDeleteMessageOperation({ opId: 'r1', channelId: 'c1', messageId: 'm1' });
    await queueDeleteMessageOperation({ opId: 'r2', channelId: 'c1', messageId: 'm2' });

    await rejectMessageOperation('r1', 'FORBIDDEN');
    await rejectMessageOperation('r2');

    await expect(getLocalFirstOperation('u1', 'r1')).resolves.toMatchObject({ state: 'rejected', lastError: 'FORBIDDEN' });
    await expect(getLocalFirstOperation('u1', 'r2')).resolves.toMatchObject({ state: 'rejected', lastError: 'MUTATION_REJECTED' });
    expect(events.filter(e => e.type.endsWith('rejected')).map(e => [e.detail.opId, e.detail.code]))
      .toEqual([['r1', 'FORBIDDEN'], ['r2', 'MUTATION_REJECTED']]);

    // A late confirmation for a rejected op does not resurrect it.
    await resolveMessageOperation('r1');
    await expect(getLocalFirstOperation('u1', 'r1')).resolves.toMatchObject({ state: 'rejected' });
  });

  it('lifecycle DOM events carry identity only — never the edited text', async () => {
    await queueEditMessageOperation({ opId: 'priv', channelId: 'c1', messageId: 'm1', content: 'my private edit', baseVersion: 1 });
    await resolveMessageOperation('priv');

    expect(events.map(e => e.type)).toEqual([
      'bridge:message-operation-dispatched',
      'bridge:message-operation-applied',
    ]);
    for (const e of events) {
      expect(Object.keys(e.detail).sort()).toEqual(['channelId', 'kind', 'opId', 'targetId']);
      expect(JSON.stringify(e.detail)).not.toContain('my private edit');
    }
  });
});
