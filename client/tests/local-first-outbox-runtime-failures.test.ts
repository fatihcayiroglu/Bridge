// P7 A3/A7 — the outbox runtime under storage failure and migration conflict.
//
// The physical store is replaced with a controllable one so the runtime's own
// failure handling is exercised: a conflict must keep the plaintext source and
// refuse to hydrate (MessageInputPanel never replays an unverified view), an
// initialization failure must be surfaced AND retryable, and a write failure
// must be reported without dropping the optimistic in-session queue.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTBOX_KEY_PREFIX,
  putOutboxEntry as putLegacyOutboxEntry,
  type OutboxEntry,
} from '../js/core/outbox-store.ts';
import { EncryptedOutboxRepository } from '../js/core/local-first/outbox.ts';
import { EncryptedLocalStore, MemoryKeyProvider, MemoryRecordBackend } from '../js/core/local-first/store.ts';

const hoisted = vi.hoisted(() => ({
  factory: null as null | ((userId: string) => Promise<unknown>),
}));

vi.mock('../js/core/local-first/indexeddb.ts', () => ({
  createBrowserLocalFirstStore: (userId: string) => hoisted.factory!(userId),
}));

const runtime = await import('../js/core/local-first/outbox-runtime.ts');

function entry(ackId: string, over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    ackId, userId: 'u1', channelId: 'c1', serverId: 's1', draftKind: 'channel',
    messageType: 'normal', content: `text-${ackId}`, createdAt: 1, state: 'queued', attempts: 0,
    ...over,
  } as OutboxEntry;
}

let shared: EncryptedLocalStore;
const errors: Array<{ userId: string; message: string }> = [];
const onError = (e: Event) => errors.push((e as CustomEvent).detail);

beforeEach(() => {
  localStorage.clear();
  errors.length = 0;
  runtime.resetLocalFirstOutboxRuntimeForTests();
  shared = new EncryptedLocalStore('u1', new MemoryRecordBackend(), new MemoryKeyProvider());
  hoisted.factory = async () => ({ store: shared, durable: true, backend: 'indexeddb' });
  document.addEventListener('bridge:outbox-persistence-error', onError);
});

afterEach(() => {
  document.removeEventListener('bridge:outbox-persistence-error', onError);
  runtime.resetLocalFirstOutboxRuntimeForTests();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('P7 outbox runtime failure handling', () => {
  it('a legacy/encrypted conflict refuses hydration, keeps the plaintext and reports it', async () => {
    await new EncryptedOutboxRepository('u1', shared).write([entry('enc')]);
    putLegacyOutboxEntry(entry('legacy'));

    await expect(runtime.hydrateLocalFirstOutbox('u1')).rejects.toBeInstanceOf(runtime.LocalFirstOutboxMigrationConflictError);
    expect(localStorage.getItem(`${OUTBOX_KEY_PREFIX}:u1`)).toContain('legacy');
    await vi.waitFor(() => expect(errors).toEqual([{ userId: 'u1', message: 'Encrypted and legacy outbox snapshots conflict' }]));
  });

  it('an initialization failure is surfaced and the next call retries instead of caching the failure', async () => {
    let calls = 0;
    hoisted.factory = async () => {
      calls += 1;
      if (calls === 1) throw 'opaque failure';
      return { store: shared, durable: false, backend: 'memory', reason: 'IndexedDB blocked' };
    };

    await expect(runtime.hydrateLocalFirstOutbox('u1')).rejects.toBe('opaque failure');
    await vi.waitFor(() => expect(errors.map(e => e.message)).toEqual(['Encrypted outbox persistence failed']));

    await expect(runtime.hydrateLocalFirstOutbox('u1')).resolves.toEqual([]);
    await expect(runtime.localFirstOutboxStorageStatus('u1')).resolves.toMatchObject({
      durable: false, backend: 'memory', reason: 'IndexedDB blocked',
    });
    expect(calls).toBe(2);
  });

  it('a failed encrypted write is reported but the optimistic queue stays; the next good write clears the error', async () => {
    await runtime.hydrateLocalFirstOutbox('u1');
    const put = vi.spyOn(shared, 'putJson').mockRejectedValueOnce(new Error('quota exceeded'));

    expect(runtime.putLocalFirstOutboxEntry(entry('a'))).toBe(true);
    await runtime.flushLocalFirstOutbox('u1');
    expect(runtime.readLocalFirstOutbox('u1').map(e => e.ackId)).toEqual(['a']);
    await expect(runtime.localFirstOutboxStorageStatus('u1')).resolves.toMatchObject({ lastPersistenceError: 'quota exceeded' });

    runtime.patchLocalFirstOutboxEntry('u1', 'a', { attempts: 1 });
    await runtime.flushLocalFirstOutbox('u1');
    expect(put).toHaveBeenCalledTimes(2);
    const status = await runtime.localFirstOutboxStorageStatus('u1');
    expect(status.lastPersistenceError).toBeUndefined();
    await expect(new EncryptedOutboxRepository('u1', shared).read()).resolves.toEqual([entry('a', { attempts: 1 })]);
  });

  it('patching an unknown ackId changes nothing; closing with a blank id is a no-op', async () => {
    await runtime.hydrateLocalFirstOutbox('u1');
    expect(runtime.patchLocalFirstOutboxEntry('u1', 'missing', { state: 'failed' })).toBeNull();
    expect(() => runtime.closeLocalFirstOutboxRuntime('  ')).not.toThrow();
    await expect(runtime.flushLocalFirstOutbox(' ')).rejects.toThrow('userId is required');
  });
});
