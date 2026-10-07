// P7 A2/A3 — canonical encrypted outbox: corrupt snapshots fail closed, ackIds
// stay unique, and the legacy plaintext migration never deletes plaintext it
// could not prove was copied (and never guesses between two different queues).

import { describe, expect, it, vi } from 'vitest';
import type { OutboxEntry } from '../js/core/outbox-store.ts';
import {
  EncryptedOutboxRepository,
  LOCAL_OUTBOX_MAX_ENTRIES,
} from '../js/core/local-first/outbox.ts';
import { EncryptedLocalStore, MemoryKeyProvider, MemoryRecordBackend } from '../js/core/local-first/store.ts';

function entry(ackId: string, over: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    ackId, userId: 'u1', channelId: 'c1', serverId: 's1', draftKind: 'channel',
    messageType: 'normal', content: `text-${ackId}`, createdAt: 1, state: 'queued', attempts: 0,
    ...over,
  } as OutboxEntry;
}

function makeRepo() {
  const store = new EncryptedLocalStore('u1', new MemoryRecordBackend(), new MemoryKeyProvider());
  return { repo: new EncryptedOutboxRepository('u1', store), store };
}

function legacy(entries: OutboxEntry[], { sticky = false } = {}) {
  let current = entries;
  return {
    read: vi.fn(() => current),
    clear: vi.fn(() => { if (!sticky) current = []; }),
  };
}

describe('P7 encrypted outbox snapshot integrity', () => {
  it.each([
    ['an array', []],
    ['a wrong version', { v: 99, entries: [] }],
    ['entries that are not an array', { v: 1, entries: {} }],
  ])('a stored snapshot with %s fails closed', async (_name, raw) => {
    const { repo, store } = makeRepo();
    await store.putJson('outbox', 'queue', raw, 1);
    await expect(repo.read()).rejects.toThrow('Invalid local-first outbox snapshot');
  });

  it('refuses duplicate ackIds, foreign-account rows and an over-full queue', async () => {
    const { repo } = makeRepo();
    await expect(repo.write([entry('a'), entry('a')])).rejects.toThrow('Duplicate');
    await expect(repo.write([entry('b', { userId: 'u2' })])).rejects.toThrow('Invalid local-first outbox entry');
    const many = Array.from({ length: LOCAL_OUTBOX_MAX_ENTRIES + 1 }, (_, i) => entry(`k${i}`));
    await expect(repo.write(many)).rejects.toThrow('full');
  });

  it('patching an unknown ackId is a no-op; an invalid patch is refused', async () => {
    const { repo } = makeRepo();
    await repo.put(entry('a'));
    await expect(repo.patch('nope', { state: 'failed' })).resolves.toBeNull();
    await expect(repo.patch('a', { attempts: -1 } as never)).rejects.toThrow('Invalid local-first outbox patch');
    await expect(repo.read()).resolves.toEqual([entry('a')]);
  });

  it('writing an empty queue removes the encrypted record', async () => {
    const { repo, store } = makeRepo();
    await repo.put(entry('a'));
    await repo.remove('a');
    await expect(store.getJson('outbox', 'queue')).resolves.toBeNull();
  });

  it('restart turns in-flight sends back into queued with the SAME ackId', async () => {
    const { repo } = makeRepo();
    await repo.write([entry('a', { state: 'sending', attempts: 1 }), entry('b', { createdAt: 2 })]);
    await expect(repo.restoreAfterRestart()).resolves.toEqual([
      entry('a', { state: 'queued', attempts: 1 }),
      entry('b', { createdAt: 2 }),
    ]);
  });
});

describe('P7 legacy outbox migration (copy → verify → delete)', () => {
  it('identical legacy and encrypted queues: plaintext is cleared, nothing duplicated', async () => {
    const { repo } = makeRepo();
    await repo.write([entry('a')]);
    const source = legacy([entry('a')]);
    await expect(repo.migrateLegacy(source)).resolves.toEqual({ status: 'already-encrypted', entries: [entry('a')] });
    expect(source.clear).toHaveBeenCalledOnce();
  });

  it('DIFFERENT legacy and encrypted queues: conflict, plaintext untouched, no guess', async () => {
    const { repo } = makeRepo();
    await repo.write([entry('a')]);
    const source = legacy([entry('b')]);
    await expect(repo.migrateLegacy(source)).resolves.toEqual({ status: 'conflict', entries: [entry('a')] });
    expect(source.clear).not.toHaveBeenCalled();
  });

  it('plaintext that survives clear() is reported, never silently kept', async () => {
    const fresh = makeRepo();
    await expect(fresh.repo.migrateLegacy(legacy([entry('a')], { sticky: true })))
      .rejects.toThrow('Legacy outbox cleanup verification failed');

    const existing = makeRepo();
    await existing.repo.write([entry('a')]);
    await expect(existing.repo.migrateLegacy(legacy([entry('a')], { sticky: true })))
      .rejects.toThrow('Legacy outbox cleanup verification failed');
  });

  it('a failed encrypted read-back keeps the plaintext source', async () => {
    const { repo } = makeRepo();
    const source = legacy([entry('a')]);
    const realRead = repo.read.bind(repo);
    let reads = 0;
    vi.spyOn(repo, 'read').mockImplementation(async () => {
      reads += 1;
      return reads === 2 ? [entry('a', { content: 'tampered' })] : realRead();
    });
    await expect(repo.migrateLegacy(source)).rejects.toThrow('migration verification failed');
    expect(source.clear).not.toHaveBeenCalled();
  });

  it('no legacy rows: reports whether an encrypted queue already exists', async () => {
    const { repo } = makeRepo();
    await expect(repo.migrateLegacy(legacy([]))).resolves.toEqual({ status: 'nothing-to-migrate', entries: [] });
    await repo.write([entry('a')]);
    await expect(repo.migrateLegacy(legacy([]))).resolves.toEqual({ status: 'already-encrypted', entries: [entry('a')] });
  });
});
