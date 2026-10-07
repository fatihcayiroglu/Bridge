import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OUTBOX_KEY_PREFIX,
  putOutboxEntry as putLegacyOutboxEntry,
  readOutbox as readLegacyOutbox,
  type OutboxEntry,
} from '../js/core/outbox-store.ts';
import {
  flushLocalFirstOutbox,
  hydrateLocalFirstOutbox,
  patchLocalFirstOutboxEntry,
  putLocalFirstOutboxEntry,
  readLocalFirstOutbox,
  removeLocalFirstOutboxEntry,
  localFirstOutboxForChannel,
  localFirstOutboxStorageStatus,
  closeLocalFirstOutboxRuntime,
  resetLocalFirstOutboxRuntimeForTests,
} from '../js/core/local-first/outbox-runtime.ts';
import { LOCAL_OUTBOX_MAX_ENTRIES } from '../js/core/local-first/outbox.ts';

function entry(ackId: string, state: OutboxEntry['state'] = 'queued'): OutboxEntry {
  return {
    ackId,
    userId: 'u1',
    channelId: 'c1',
    serverId: 's1',
    draftKind: 'channel',
    messageType: 'normal',
    content: `secret-${ackId}`,
    createdAt: ackId === 'a' ? 1 : 2,
    state,
    attempts: 0,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetLocalFirstOutboxRuntimeForTests();
});

afterEach(() => {
  resetLocalFirstOutboxRuntimeForTests();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('P7 local-first outbox runtime', () => {
  it('migrates the legacy plaintext queue before replay', async () => {
    putLegacyOutboxEntry(entry('a', 'sending'));
    expect(readLegacyOutbox('u1')).toHaveLength(1);

    await expect(hydrateLocalFirstOutbox('u1')).resolves.toEqual([
      entry('a', 'queued'),
    ]);

    expect(localStorage.getItem(`${OUTBOX_KEY_PREFIX}:u1`)).toBeNull();
  });

  it('new queue writes never create a plaintext legacy outbox', async () => {
    expect(putLocalFirstOutboxEntry(entry('a'))).toBe(true);
    await flushLocalFirstOutbox('u1');

    expect(readLocalFirstOutbox('u1')).toEqual([entry('a')]);
    expect(localStorage.getItem(`${OUTBOX_KEY_PREFIX}:u1`)).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain('secret-a');
  });

  it('patches the same ackId in place', async () => {
    putLocalFirstOutboxEntry(entry('a'));
    const patched = patchLocalFirstOutboxEntry('u1', 'a', {
      state: 'failed',
      attempts: 1,
      lastError: 'timeout',
    });

    expect(patched).toMatchObject({
      ackId: 'a',
      state: 'failed',
      attempts: 1,
      lastError: 'timeout',
    });
    expect(readLocalFirstOutbox('u1')).toHaveLength(1);
    await flushLocalFirstOutbox('u1');
  });

  it('removes acknowledged entries without touching another ackId', async () => {
    putLocalFirstOutboxEntry(entry('a'));
    putLocalFirstOutboxEntry(entry('b'));
    removeLocalFirstOutboxEntry('u1', 'a');

    expect(readLocalFirstOutbox('u1').map(value => value.ackId)).toEqual(['b']);
    await flushLocalFirstOutbox('u1');
  });

  it('keeps the active queue usable while physical persistence initializes', () => {
    expect(putLocalFirstOutboxEntry(entry('a'))).toBe(true);
    expect(readLocalFirstOutbox('u1')).toEqual([entry('a')]);
  });
});


describe('P7 outbox runtime boundary coverage', () => {
  it('rejects blank account ids at every public account boundary', async () => {
    expect(() => readLocalFirstOutbox('')).toThrow('Outbox userId is required');
    await expect(hydrateLocalFirstOutbox('')).rejects.toThrow('Outbox userId is required');
    expect(() => patchLocalFirstOutboxEntry('', 'a', {})).toThrow('Outbox userId is required');
    expect(() => removeLocalFirstOutboxEntry('', 'a')).toThrow('Outbox userId is required');
    await expect(flushLocalFirstOutbox('')).rejects.toThrow('Outbox userId is required');
    await expect(localFirstOutboxStorageStatus('')).rejects.toThrow('Outbox userId is required');
    expect(() => closeLocalFirstOutboxRuntime('')).not.toThrow();
  });

  it('updates an existing optimistic ack in place and filters by channel', async () => {
    expect(putLocalFirstOutboxEntry(entry('a'))).toBe(true);
    expect(putLocalFirstOutboxEntry({
      ...entry('b'),
      channelId: 'c2',
      createdAt: 1,
    })).toBe(true);
    expect(putLocalFirstOutboxEntry({
      ...entry('a'),
      state: 'failed',
      attempts: 2,
      lastError: 'retry-me',
    })).toBe(true);

    expect(readLocalFirstOutbox('u1')).toHaveLength(2);
    expect(readLocalFirstOutbox('u1')[0]?.ackId).toBe('a');
    expect(readLocalFirstOutbox('u1')[0]).toMatchObject({
      state: 'failed',
      attempts: 2,
      lastError: 'retry-me',
    });
    expect(localFirstOutboxForChannel('u1', 'c2').map(row => row.ackId)).toEqual(['b']);
    expect(patchLocalFirstOutboxEntry('u1', 'missing', { state: 'failed' })).toBeNull();
    await flushLocalFirstOutbox('u1');
  });

  it('rejects only NEW rows when the optimistic queue is full', async () => {
    for (let index = 0; index < LOCAL_OUTBOX_MAX_ENTRIES; index += 1) {
      expect(putLegacyOutboxEntry({
        ...entry('legacy-' + index),
        ackId: 'legacy-' + index,
        createdAt: index,
      })).toBe(true);
    }

    expect(readLocalFirstOutbox('u1')).toHaveLength(LOCAL_OUTBOX_MAX_ENTRIES);
    expect(putLocalFirstOutboxEntry({
      ...entry('overflow'),
      ackId: 'overflow',
      createdAt: 999,
    })).toBe(false);

    // Existing ack updates are still allowed at capacity.
    expect(putLocalFirstOutboxEntry({
      ...entry('legacy-0'),
      ackId: 'legacy-0',
      state: 'failed',
      attempts: 1,
      createdAt: 0,
    })).toBe(true);
    expect(readLocalFirstOutbox('u1')).toHaveLength(LOCAL_OUTBOX_MAX_ENTRIES);
    await flushLocalFirstOutbox('u1');
  });

  it('reports the intentional memory fallback and drops volatile state on close', async () => {
    vi.stubGlobal('indexedDB', undefined);
    expect(putLocalFirstOutboxEntry(entry('a'))).toBe(true);
    await flushLocalFirstOutbox('u1');

    await expect(localFirstOutboxStorageStatus('u1')).resolves.toMatchObject({
      userId: 'u1',
      durable: false,
      backend: 'memory',
      reason: 'IndexedDB unavailable',
    });

    closeLocalFirstOutboxRuntime('u1');
    expect(readLocalFirstOutbox('u1')).toEqual([]);
  });
});
