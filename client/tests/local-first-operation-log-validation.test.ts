// P7 A5 — the encrypted operation log must fail closed on malformed input and
// on tampered/corrupt persisted rows. A replay owner that trusted a bad row
// could emit an edit/delete/reaction the user never made.

import { describe, expect, it } from 'vitest';
import {
  EncryptedOperationLog,
  LOCAL_OPLOG_TERMINAL_RETENTION_MS,
  type NewLocalOperation,
} from '../js/core/local-first/operation-log.ts';
import {
  EncryptedLocalStore,
  MemoryKeyProvider,
  MemoryRecordBackend,
} from '../js/core/local-first/store.ts';

function makeLog(userId = 'u1') {
  const store = new EncryptedLocalStore(userId, new MemoryRecordBackend(), new MemoryKeyProvider());
  return { log: new EncryptedOperationLog(userId, store), store };
}

const base = (over: Partial<NewLocalOperation> = {}): NewLocalOperation => ({
  opId: 'op-1',
  userId: 'u1',
  channelId: 'c1',
  targetId: 'm1',
  kind: 'delete-message',
  payload: {},
  createdAt: 1,
  ...over,
} as NewLocalOperation);

/** A well-formed persisted row; tests corrupt one field at a time. */
const row = (over: Record<string, unknown> = {}) => ({
  v: 1, opId: 'stored', userId: 'u1', channelId: 'c1', targetId: 'm1',
  kind: 'delete-message', state: 'queued', payload: {}, createdAt: 1, updatedAt: 1, attempts: 0,
  ...over,
});

describe('P7 operation log input validation', () => {
  it.each([
    ['edit with empty content', { kind: 'edit-message', payload: { content: '   ', baseVersion: 1 } }, 'Edit payload'],
    ['edit over 2000 chars', { kind: 'edit-message', payload: { content: 'x'.repeat(2001), baseVersion: 1 } }, 'Edit payload'],
    ['edit with non-integer version', { kind: 'edit-message', payload: { content: 'ok', baseVersion: 1.5 } }, 'Edit payload'],
    ['edit with negative version', { kind: 'edit-message', payload: { content: 'ok', baseVersion: -1 } }, 'Edit payload'],
    ['delete reason over 200 chars', { payload: { reason: 'r'.repeat(201) } }, 'Delete reason'],
    ['reaction without emoji', { kind: 'reaction-state', payload: { emoji: ' ', desired: true } }, 'Reaction payload'],
    ['reaction emoji too long', { kind: 'reaction-state', payload: { emoji: 'x'.repeat(11), desired: true } }, 'Reaction payload'],
    ['reaction desired as a string', { kind: 'reaction-state', payload: { emoji: '👍', desired: 'true' } }, 'Reaction payload'],
    ['array payload', { payload: [] }, 'payload is invalid'],
    ['null payload', { payload: null }, 'payload is invalid'],
    ['unknown kind', { kind: 'ban-member' }, 'kind is invalid'],
    ['missing channel', { channelId: ' ' }, 'channelId is required'],
    ['oversized op id', { opId: 'o'.repeat(129) }, 'opId is too large'],
    ['negative createdAt', { createdAt: -5 }, 'timestamps/attempts'],
  ])('rejects %s before anything is persisted', async (_name, over, message) => {
    const { log } = makeLog();
    await expect(log.enqueue(base(over as Partial<NewLocalOperation>), 10)).rejects.toThrow(message);
    await expect(log.listAll()).resolves.toEqual([]);
  });

  it('normalizes a whitespace-only delete reason away and keeps a real one trimmed', async () => {
    const { log } = makeLog();
    await expect(log.enqueue(base({ opId: 'a', payload: { reason: '   ' } }), 1)).resolves.toMatchObject({ payload: {} });
    await expect(log.enqueue(base({ opId: 'b', targetId: 'm2', payload: { reason: ' spam ' } }), 1))
      .resolves.toMatchObject({ payload: { reason: 'spam' } });
  });

  it('refuses an operation that names another account', async () => {
    const { log } = makeLog();
    await expect(log.enqueue(base({ userId: 'u2' }), 1)).rejects.toThrow('account mismatch');
  });

  it('refuses transitions of unknown operations and keeps terminal rows terminal', async () => {
    const { log } = makeLog();
    await expect(log.transition('missing', 'sending')).rejects.toThrow('not found');
    await log.enqueue(base(), 1);
    await log.transition('op-1', 'rejected', { lastError: 'forbidden' }, 2);
    await expect(log.transition('op-1', 'sending', {}, 3)).rejects.toThrow('Invalid operation transition');
    await expect(log.transition('op-1', 'applied', {}, 3)).rejects.toThrow('Invalid operation transition');
  });

  it('applied clears the last error; an explicit error is bounded', async () => {
    const { log } = makeLog();
    await log.enqueue(base(), 1);
    await expect(log.transition('op-1', 'sending', { lastError: 'e'.repeat(900) }, 2))
      .resolves.toMatchObject({ lastError: 'e'.repeat(500) });
    const applied = await log.transition('op-1', 'applied', {}, 3);
    expect(applied.lastError).toBeUndefined();
  });

  it('removeTerminal discards only terminal rows and is a no-op for unknown ids', async () => {
    const { log } = makeLog();
    await expect(log.removeTerminal('missing')).resolves.toBeUndefined();
    await log.enqueue(base(), 1);
    await expect(log.removeTerminal('op-1')).rejects.toThrow('Active operation cannot be discarded');
    await log.transition('op-1', 'superseded', { supersededBy: 'op-2' }, 2);
    await log.removeTerminal('op-1');
    await expect(log.get('op-1')).resolves.toBeNull();
  });
});

describe('P7 operation log fails closed on corrupt persisted rows', () => {
  it.each([
    ['an unknown state', { state: 'done' }, 'state is invalid'],
    ['updatedAt before createdAt', { createdAt: 10, updatedAt: 5 }, 'timestamps/attempts'],
    ['fractional attempts', { attempts: 1.5 }, 'timestamps/attempts'],
    ['negative attempts', { attempts: -1 }, 'timestamps/attempts'],
    ['a non-finite timestamp', { createdAt: 'soon' }, 'timestamps/attempts'],
    ['an unknown kind', { kind: 'nuke' }, 'kind is invalid'],
    ['a malformed payload', { kind: 'edit-message', payload: { content: '' } }, 'Edit payload'],
  ])('a stored row with %s is refused, not replayed', async (_name, over, message) => {
    const { log, store } = makeLog();
    await store.putJson('oplog', 'stored', row(over), 1);
    await expect(log.get('stored')).rejects.toThrow(message);
    await expect(log.listActive()).rejects.toThrow(message);
  });

  it('a row that names another account is refused by id and invisible in listings', async () => {
    const { log, store } = makeLog();
    await store.putJson('oplog', 'stored', row({ userId: 'intruder' }), 1);
    await expect(log.get('stored')).rejects.toThrow('account mismatch');
    await expect(log.listAll()).resolves.toEqual([]);
  });
});

describe('P7 operation log retention', () => {
  it('compaction drops terminal rows past retention, keeps fresh terminal and every active row', async () => {
    const { log } = makeLog();
    await log.enqueue(base({ opId: 'old', targetId: 'm-old' }), 1);
    await log.transition('old', 'applied', {}, 2);
    await log.enqueue(base({ opId: 'fresh', targetId: 'm-fresh', createdAt: LOCAL_OPLOG_TERMINAL_RETENTION_MS }), LOCAL_OPLOG_TERMINAL_RETENTION_MS);
    await log.transition('fresh', 'applied', {}, LOCAL_OPLOG_TERMINAL_RETENTION_MS + 1);
    await log.enqueue(base({ opId: 'active', targetId: 'm-active', createdAt: 3 }), 3);

    const remaining = await log.compact(LOCAL_OPLOG_TERMINAL_RETENTION_MS + 10);
    expect(remaining.map(r => r.opId).sort()).toEqual(['active', 'fresh']);
    await expect(log.get('old')).resolves.toBeNull();
    await expect(log.get('active')).resolves.toMatchObject({ state: 'queued' });
  });
});
