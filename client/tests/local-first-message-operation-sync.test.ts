import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import {
  handleMessageOperationSocketDisconnected,
  queueDeleteMessageOperation,
  queueEditMessageOperation,
  queueReactionMessageOperation,
  rejectMessageOperation,
  replayMessageOperations,
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
