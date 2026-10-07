import { describe, expect, it } from 'vitest';
import {
  EncryptedOperationLog,
  LOCAL_OPLOG_MAX_ACTIVE,
} from '../js/core/local-first/operation-log.ts';
import {
  EncryptedLocalStore,
  MemoryKeyProvider,
  MemoryRecordBackend,
} from '../js/core/local-first/store.ts';

function makeLog() {
  const backend = new MemoryRecordBackend();
  const store = new EncryptedLocalStore('u1', backend, new MemoryKeyProvider());
  return { log: new EncryptedOperationLog('u1', store), backend };
}

describe('P7 encrypted non-send operation log', () => {
  it('tracks queued -> sending -> applied with stable op id', async () => {
    const { log } = makeLog();
    await log.enqueue({
      opId: 'nonce-1',
      userId: 'u1',
      channelId: 'c1',
      targetId: 'm1',
      kind: 'edit-message',
      payload: { content: 'edited', baseVersion: 1 },
      createdAt: 1,
    }, 1);

    await expect(log.transition('nonce-1', 'sending', { incrementAttempts: true }, 2))
      .resolves.toMatchObject({ opId: 'nonce-1', state: 'sending', attempts: 1 });
    await expect(log.transition('nonce-1', 'applied', {}, 3))
      .resolves.toMatchObject({ opId: 'nonce-1', state: 'applied', attempts: 1 });
  });

  it('same op id is idempotent only when identity and payload match', async () => {
    const { log } = makeLog();
    const input = {
      opId: 'same',
      userId: 'u1',
      channelId: 'c1',
      targetId: 'm1',
      kind: 'delete-message' as const,
      payload: {},
      createdAt: 1,
    };

    const first = await log.enqueue(input, 1);
    const second = await log.enqueue(input, 2);
    expect(second).toEqual(first);

    await expect(log.enqueue({
      ...input,
      payload: { reason: 'different' },
    }, 3)).rejects.toThrow('collision');
  });

  it('new reaction desired-state supersedes older queued state for the same emoji', async () => {
    const { log } = makeLog();

    await log.enqueue({
      opId: 'r1', userId: 'u1', channelId: 'c1', targetId: 'm1',
      kind: 'reaction-state', payload: { emoji: '👍', desired: true }, createdAt: 1,
    }, 1);
    await log.enqueue({
      opId: 'r2', userId: 'u1', channelId: 'c1', targetId: 'm1',
      kind: 'reaction-state', payload: { emoji: '👍', desired: false }, createdAt: 2,
    }, 2);

    expect(await log.get('r1')).toMatchObject({ state: 'superseded', supersededBy: 'r2' });
    expect(await log.get('r2')).toMatchObject({ state: 'queued' });
  });

  it('does not supersede an in-flight operation until the server resolves it', async () => {
    const { log } = makeLog();
    await log.enqueue({
      opId: 'edit-1', userId: 'u1', channelId: 'c1', targetId: 'm1',
      kind: 'edit-message', payload: { content: 'first', baseVersion: 1 }, createdAt: 1,
    }, 1);
    await log.transition('edit-1', 'sending', { incrementAttempts: true }, 2);

    await log.enqueue({
      opId: 'edit-2', userId: 'u1', channelId: 'c1', targetId: 'm1',
      kind: 'edit-message', payload: { content: 'second', baseVersion: 1 }, createdAt: 3,
    }, 3);

    expect(await log.get('edit-1')).toMatchObject({ state: 'sending' });
    expect(await log.get('edit-2')).toMatchObject({ state: 'queued' });
  });

  it('treats server rejection as terminal evidence instead of auto-replaying it', async () => {
    const { log } = makeLog();
    await log.enqueue({
      opId: 'reject-me',
      userId: 'u1',
      channelId: 'c1',
      targetId: 'm1',
      kind: 'delete-message',
      payload: {},
      createdAt: 1,
    }, 1);
    await log.transition('reject-me', 'sending', { incrementAttempts: true }, 2);
    await log.transition('reject-me', 'rejected', { lastError: 'forbidden' }, 3);

    expect(await log.listActive()).toEqual([]);
    await expect(log.transition('reject-me', 'queued', {}, 4)).rejects.toThrow('Invalid');
  });

  it('accepts a late authoritative confirmation after disconnect re-queued an in-flight op', async () => {
    const { log } = makeLog();
    await log.enqueue({
      opId: 'late-ack',
      userId: 'u1',
      channelId: 'c1',
      targetId: 'm1',
      kind: 'delete-message',
      payload: {},
      createdAt: 1,
    }, 1);
    await log.transition('late-ack', 'sending', { incrementAttempts: true }, 2);
    await log.transition('late-ack', 'queued', { lastError: 'disconnected' }, 3);

    await expect(log.transition('late-ack', 'applied', {}, 4))
      .resolves.toMatchObject({ state: 'applied', attempts: 1 });
  });

  it('rejects unsafe state transitions', async () => {
    const { log } = makeLog();
    await log.enqueue({
      opId: 'x', userId: 'u1', channelId: 'c1', targetId: 'm1',
      kind: 'delete-message', payload: {}, createdAt: 1,
    }, 1);
    await log.transition('x', 'sending', {}, 2);
    await log.transition('x', 'applied', {}, 3);

    await expect(log.transition('x', 'queued', {}, 4)).rejects.toThrow('Invalid');
  });

  it('bounds active operations without evicting user mutations', async () => {
    const { log } = makeLog();

    for (let index = 0; index < LOCAL_OPLOG_MAX_ACTIVE; index += 1) {
      await log.enqueue({
        opId: `op-${index}`,
        userId: 'u1',
        channelId: 'c1',
        targetId: `m-${index}`,
        kind: 'delete-message',
        payload: {},
        createdAt: index,
      }, index);
    }

    await expect(log.enqueue({
      opId: 'overflow',
      userId: 'u1',
      channelId: 'c1',
      targetId: 'overflow',
      kind: 'delete-message',
      payload: {},
      createdAt: 999,
    }, 999)).rejects.toThrow('full');

    expect(await log.listActive()).toHaveLength(LOCAL_OPLOG_MAX_ACTIVE);
  });

  it('keeps operation payload encrypted at the physical backend', async () => {
    const { log, backend } = makeLog();
    await log.enqueue({
      opId: 'secret-op',
      userId: 'u1',
      channelId: 'c1',
      targetId: 'm1',
      kind: 'edit-message',
      payload: { content: 'private edit text', baseVersion: 1 },
      createdAt: 1,
    }, 1);

    const raw = await backend.listByPrefix('u:u1|n:oplog|');
    expect(JSON.stringify(raw)).not.toContain('private edit text');
  });
});
