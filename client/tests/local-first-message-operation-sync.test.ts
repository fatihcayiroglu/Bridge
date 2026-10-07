import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import {
  handleMessageOperationSocketDisconnected,
  queueDeleteMessageOperation,
  queueEditMessageOperation,
  queueReactionMessageOperation,
  rejectMessageOperation,
  replayMessageOperations,
  MESSAGE_OPERATION_ACK_TIMEOUT_MS,
  resetMessageOperationSyncForTests,
  resolveMessageOperation,
} from '../js/core/local-first/message-operation-sync.ts';
import { getLocalFirstOperation } from '../js/core/local-first/operation-runtime.ts';

function makeSocket() {
  return { emit: vi.fn() };
}

let socket: ReturnType<typeof makeSocket>;
let connected: boolean;

beforeEach(() => {
  resetMessageOperationSyncForTests();
  socket = makeSocket();
  connected = true;
  BridgeRegistry.register('getMe', (() => ({ _id: 'u1' })) as AnyFn);
  BridgeRegistry.register('getSocketConnected', (() => connected) as AnyFn);
  BridgeRegistry.register('socket', socket as unknown as AnyFn);
});

afterEach(() => {
  vi.useRealTimers();
  resetMessageOperationSyncForTests();
  BridgeRegistry.unregister('getMe');
  BridgeRegistry.unregister('getSocketConnected');
  BridgeRegistry.unregister('socket');
  vi.restoreAllMocks();
});

describe('P7 durable message operation replay owner', () => {
  it('persists an edit before emitting it with the same stable nonce and base version', async () => {
    const queued = await queueEditMessageOperation({
      opId: 'edit-op-1',
      channelId: 'c1',
      messageId: 'm1',
      content: 'edited text',
      baseVersion: 42,
    });

    expect(queued).toEqual({ opId: 'edit-op-1', dispatched: true });
    expect(socket.emit).toHaveBeenCalledWith('message:edit', {
      messageId: 'm1',
      channelId: 'c1',
      content: 'edited text',
      clientNonce: 'edit-op-1',
      baseVersion: 42,
    });
    await expect(getLocalFirstOperation('u1', 'edit-op-1')).resolves.toMatchObject({
      state: 'sending',
      attempts: 1,
    });

    await resolveMessageOperation('edit-op-1');
    await expect(getLocalFirstOperation('u1', 'edit-op-1')).resolves.toMatchObject({
      state: 'applied',
    });
  });

  it('queues while offline and replays the same delete nonce after reconnect', async () => {
    connected = false;
    const queued = await queueDeleteMessageOperation({
      opId: 'delete-op-1',
      channelId: 'c1',
      messageId: 'm1',
    });

    expect(queued.dispatched).toBe(false);
    expect(socket.emit).not.toHaveBeenCalled();
    await expect(getLocalFirstOperation('u1', 'delete-op-1')).resolves.toMatchObject({
      state: 'queued',
      attempts: 0,
    });

    connected = true;
    await replayMessageOperations(true);
    expect(socket.emit).toHaveBeenCalledTimes(1);
    expect(socket.emit).toHaveBeenLastCalledWith('message:delete', {
      messageId: 'm1',
      channelId: 'c1',
      clientNonce: 'delete-op-1',
    });

    connected = false;
    await handleMessageOperationSocketDisconnected();
    await expect(getLocalFirstOperation('u1', 'delete-op-1')).resolves.toMatchObject({
      state: 'queued',
      attempts: 1,
    });

    connected = true;
    await replayMessageOperations(true);
    expect(socket.emit).toHaveBeenCalledTimes(2);
    expect(socket.emit.mock.calls[1]?.[1]).toMatchObject({ clientNonce: 'delete-op-1' });
    await expect(getLocalFirstOperation('u1', 'delete-op-1')).resolves.toMatchObject({
      state: 'sending',
      attempts: 2,
    });
  });

  it('serializes desired-state reactions for the same message and emoji', async () => {
    const first = await queueReactionMessageOperation({
      opId: 'reaction-1',
      channelId: 'c1',
      messageId: 'm1',
      emoji: '👍',
      desired: true,
    });
    expect(first.dispatched).toBe(true);

    const second = await queueReactionMessageOperation({
      opId: 'reaction-2',
      channelId: 'c1',
      messageId: 'm1',
      emoji: '👍',
      desired: false,
    });
    expect(second.dispatched).toBe(false);
    expect(socket.emit).toHaveBeenCalledTimes(1);
    await expect(getLocalFirstOperation('u1', 'reaction-2')).resolves.toMatchObject({ state: 'queued' });

    await resolveMessageOperation('reaction-1');
    await replayMessageOperations(false);

    expect(socket.emit).toHaveBeenCalledTimes(2);
    expect(socket.emit).toHaveBeenLastCalledWith('message:react', {
      messageId: 'm1',
      channelId: 'c1',
      emoji: '👍',
      active: false,
      clientNonce: 'reaction-2',
    });
  });

  it('rejects invalid durable edit versions before touching storage or socket', async () => {
    await expect(queueEditMessageOperation({
      channelId: 'c1',
      messageId: 'm1',
      content: 'edit',
      baseVersion: -1,
    })).rejects.toThrow('baseVersion');
    expect(socket.emit).not.toHaveBeenCalled();
  });

  it('requires an authenticated account and non-empty operation identity fields', async () => {
    BridgeRegistry.unregister('getMe');
    await expect(queueDeleteMessageOperation({
      channelId: 'c1',
      messageId: 'm1',
    })).rejects.toThrow('userId');

    BridgeRegistry.register('getMe', (() => ({ id: 'u1' })) as AnyFn);
    await expect(queueDeleteMessageOperation({
      channelId: '',
      messageId: 'm1',
    })).rejects.toThrow('channelId');
    await expect(queueDeleteMessageOperation({
      channelId: 'c1',
      messageId: '',
    })).rejects.toThrow('messageId');
  });

  it('keeps a durable queued operation when no socket owner exists', async () => {
    BridgeRegistry.unregister('socket');

    const queued = await queueDeleteMessageOperation({
      opId: 'no-socket',
      channelId: 'c1',
      messageId: 'm1',
    });

    expect(queued).toEqual({ opId: 'no-socket', dispatched: false });
    await expect(getLocalFirstOperation('u1', 'no-socket')).resolves.toMatchObject({
      state: 'queued',
      attempts: 0,
    });
  });

  it('uses the connected fallback when no explicit socket-connected owner is registered', async () => {
    BridgeRegistry.unregister('getSocketConnected');

    const queued = await queueReactionMessageOperation({
      opId: 'implicit-connected',
      channelId: 'c1',
      messageId: 'm1',
      emoji: '👍',
      desired: true,
    });

    expect(queued.dispatched).toBe(true);
    expect(socket.emit).toHaveBeenCalledWith('message:react', expect.objectContaining({
      clientNonce: 'implicit-connected',
      active: true,
    }));
  });

  it('re-queues safely when socket emit throws instead of losing the mutation', async () => {
    BridgeRegistry.unregister('socket');
    const throwingSocket = {
      emit: vi.fn(() => { throw new Error('transport exploded'); }),
    };
    BridgeRegistry.register('socket', throwingSocket as unknown as AnyFn);

    const queued = await queueDeleteMessageOperation({
      opId: 'emit-failure',
      channelId: 'c1',
      messageId: 'm1',
    });

    expect(queued.dispatched).toBe(false);
    await expect(getLocalFirstOperation('u1', 'emit-failure')).resolves.toMatchObject({
      state: 'queued',
      attempts: 1,
      lastError: 'socket-emit-failed',
    });
  });

  it('records an ACK timeout without discarding the in-flight operation', async () => {
    vi.useFakeTimers();

    const queued = await queueEditMessageOperation({
      opId: 'timeout-op',
      channelId: 'c1',
      messageId: 'm1',
      content: 'edit survives timeout',
      baseVersion: 1,
    });
    expect(queued.dispatched).toBe(true);

    await vi.advanceTimersByTimeAsync(MESSAGE_OPERATION_ACK_TIMEOUT_MS + 1);

    await expect(getLocalFirstOperation('u1', 'timeout-op')).resolves.toMatchObject({
      state: 'sending',
      attempts: 1,
      lastError: 'ack-timeout',
    });
  });

  it('treats empty, unknown and already-terminal confirmations as harmless no-ops', async () => {
    await expect(resolveMessageOperation('')).resolves.toBeUndefined();
    await expect(rejectMessageOperation('', 'NOPE')).resolves.toBeUndefined();
    await expect(resolveMessageOperation('missing-op')).resolves.toBeUndefined();
    await expect(rejectMessageOperation('missing-op', 'NOPE')).resolves.toBeUndefined();

    await queueDeleteMessageOperation({
      opId: 'terminal-op',
      channelId: 'c1',
      messageId: 'm1',
    });
    await resolveMessageOperation('terminal-op');
    await expect(resolveMessageOperation('terminal-op')).resolves.toBeUndefined();
    await expect(rejectMessageOperation('terminal-op', 'LATE')).resolves.toBeUndefined();

    await expect(getLocalFirstOperation('u1', 'terminal-op')).resolves.toMatchObject({
      state: 'applied',
    });
  });

  it('never auto-replays a server-rejected operation', async () => {
    await queueReactionMessageOperation({
      opId: 'reaction-rejected',
      channelId: 'c1',
      messageId: 'm1',
      emoji: '👍',
      desired: true,
    });
    expect(socket.emit).toHaveBeenCalledTimes(1);

    await rejectMessageOperation('reaction-rejected', 'MUTATION_REJECTED');
    await expect(getLocalFirstOperation('u1', 'reaction-rejected')).resolves.toMatchObject({
      state: 'rejected',
      lastError: 'MUTATION_REJECTED',
    });

    await handleMessageOperationSocketDisconnected();
    await replayMessageOperations(true);
    expect(socket.emit).toHaveBeenCalledTimes(1);
  });
});
