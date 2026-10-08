import { describe, expect, it } from 'vitest';
import {
  EncryptedHistoryRepository,
  LOCAL_HISTORY_MAX_AGE_MS,
  LOCAL_HISTORY_MAX_MESSAGES,
} from '../js/core/local-first/history.ts';
import {
  EncryptedLocalStore,
  MemoryKeyProvider,
  MemoryRecordBackend,
} from '../js/core/local-first/store.ts';

function repo() {
  const backend = new MemoryRecordBackend();
  const store = new EncryptedLocalStore('u1', backend, new MemoryKeyProvider());
  return { repository: new EncryptedHistoryRepository(store), backend, store };
}

function message(id: string, createdAt: number, extra: Record<string, unknown> = {}) {
  return { _id: id, channelId: 'c1', content: `secret-${id}`, createdAt, ...extra };
}

describe('P7 encrypted message history', () => {
  it('snapshots reactive Proxy rows and nested JSON without a DataCloneError', async () => {
    const { repository } = repo();
    const nested = new Proxy({ content: 'reactive nested' }, {});
    const source = new Proxy(message('proxy', 10, { embeds: [nested] }), {});
    expect(() => structuredClone(source)).toThrow();

    await repository.replaceFromServer('c1', [source], 100);
    const first = await repository.read('c1', 100);
    expect(first?.messages[0]?.embeds).toEqual([{ content: 'reactive nested' }]);

    await repository.update('c1', new Proxy(message('proxy', 10, { content: 'edited' }), {}), 110);
    const updated = await repository.read('c1', 110);
    expect(updated?.messages[0]?.content).toBe('edited');
    expect(updated?.messages[0]?.embeds).toEqual([{ content: 'reactive nested' }]);
  });

  it('stores confirmed history as ciphertext and restores chronological rows', async () => {
    const { repository, backend } = repo();

    await repository.replaceFromServer('c1', [
      message('b', 20),
      message('a', 10),
    ], 100);

    await expect(repository.read('c1', 100)).resolves.toMatchObject({
      messages: [{ _id: 'a' }, { _id: 'b' }],
    });
    const raw = await backend.listByPrefix('u:u1|n:history|');
    expect(JSON.stringify(raw)).not.toContain('secret-a');
    expect(JSON.stringify(raw)).not.toContain('secret-b');
  });

  it('never persists pending or failed optimistic rows', async () => {
    const { repository } = repo();

    await repository.replaceFromServer('c1', [
      message('server', 1),
      message('pending:ack-1', 2, { pending: true }),
      message('failed-local', 3, { failed: true }),
    ], 10);

    await expect(repository.read('c1', 10)).resolves.toMatchObject({
      messages: [{ _id: 'server' }],
    });
  });

  it('keeps a bounded newest window instead of silently evicting unsent data', async () => {
    const { repository } = repo();
    const rows = Array.from({ length: LOCAL_HISTORY_MAX_MESSAGES + 20 }, (_, index) =>
      message(`m-${index}`, index),
    );

    await repository.replaceFromServer('c1', rows, 500);
    const snapshot = await repository.read('c1', 500);

    expect(snapshot?.messages).toHaveLength(LOCAL_HISTORY_MAX_MESSAGES);
    expect(snapshot?.messages[0]?._id).toBe('m-20');
    expect(snapshot?.messages.at(-1)?._id).toBe(`m-${LOCAL_HISTORY_MAX_MESSAGES + 19}`);
  });

  it('tombstones deleted messages so a stale page cannot resurrect them', async () => {
    const { repository } = repo();
    await repository.replaceFromServer('c1', [message('keep', 1), message('gone', 2)], 10);
    await repository.tombstone('c1', 'gone', 20);

    await repository.replaceFromServer('c1', [
      message('keep', 1),
      message('gone', 2),
      message('new', 3),
    ], 30);

    const snapshot = await repository.read('c1', 30);
    expect(snapshot?.messages.map(row => row._id)).toEqual(['keep', 'new']);
    expect(snapshot?.tombstones).toContainEqual({ id: 'gone', deletedAt: 20 });
  });

  it('updates a known message without creating duplicates', async () => {
    const { repository } = repo();
    await repository.replaceFromServer('c1', [message('m1', 1)], 10);

    await repository.update('c1', message('m1', 1, { content: 'edited' }), 20);

    const snapshot = await repository.read('c1', 20);
    expect(snapshot?.messages).toHaveLength(1);
    expect(snapshot?.messages[0]?.content).toBe('edited');
  });

  it('expires disposable confirmed history after the retention window', async () => {
    const { repository } = repo();
    await repository.replaceFromServer('c1', [message('m1', 1)], 1);

    await expect(repository.read('c1', LOCAL_HISTORY_MAX_AGE_MS + 2)).resolves.toBeNull();
    await expect(repository.read('c1', LOCAL_HISTORY_MAX_AGE_MS + 2)).resolves.toBeNull();
  });

  it('rejects another channel row from entering this channel cache', async () => {
    const { repository } = repo();
    await repository.replaceFromServer('c1', [
      message('ok', 1),
      { _id: 'other', channelId: 'c2', content: 'wrong channel', createdAt: 2 },
    ], 10);

    const snapshot = await repository.read('c1', 10);
    expect(snapshot?.messages.map(row => row._id)).toEqual(['ok']);
  });

  it('filters every non-authoritative optimistic/deleted/malformed row fail-closed', async () => {
    const { repository } = repo();
    await repository.replaceFromServer('c1', [
      null,
      [],
      { _id: 1, channelId: 'c1' },
      { _id: '', channelId: 'c1' },
      { _id: 'x'.repeat(513), channelId: 'c1' },
      message('pending:ack', 1),
      message('pending-flag', 2, { pending: true }),
      message('failed', 3, { failed: true }),
      message('deleted', 4, { deletedAt: 4 }),
      message('wrong-channel', 5, { channelId: 'c2' }),
      message('dup', 6, { content: 'old' }),
      message('dup', 7, { content: 'new' }),
      message('no-time', Number.NaN),
    ], 20);

    const snapshot = await repository.read('c1', 20);
    expect(snapshot?.messages.map(row => row._id)).toEqual(['no-time', 'dup']);
    expect(snapshot?.messages.find(row => row._id === 'dup')?.content).toBe('new');
  });

  it('normalizes tombstones by validity, newest delete, retention and hard bound', async () => {
    const { repository, store } = repo();
    const now = LOCAL_HISTORY_MAX_AGE_MS + 1_000;
    const tombstones = [
      null,
      { id: '', deletedAt: now },
      { id: 'bad-time', deletedAt: Number.NaN },
      { id: 'negative', deletedAt: -1 },
      { id: 'expired', deletedAt: 1 },
      { id: 'dup', deletedAt: now - 20 },
      { id: 'dup', deletedAt: now - 10 },
      ...Array.from({ length: 520 }, (_, index) => ({ id: `t-${index}`, deletedAt: now - index })),
    ] as unknown[];

    await store.putJson('history', 'channel:c1', {
      v: 1,
      channelId: 'c1',
      savedAt: now,
      messages: [message('dup', now), message('keep', now)],
      tombstones,
    }, now);

    const snapshot = await repository.read('c1', now);
    expect(snapshot?.tombstones).toHaveLength(500);
    expect(snapshot?.tombstones.find(row => row.id === 'expired')).toBeUndefined();
    expect(snapshot?.tombstones.filter(row => row.id === 'dup')).toHaveLength(1);
    expect(snapshot?.messages.map(row => row._id)).toEqual(['keep']);
  });

  it('rejects malformed encrypted snapshots instead of treating them as authorized cache', async () => {
    // JSON null carries no message data and is deliberately fail-closed as a
    // cache miss; it must never become an authorized snapshot.
    {
      const { repository, store } = repo();
      await store.putJson('history', 'channel:c1', null, 10);
      await expect(repository.read('c1', 10)).resolves.toBeNull();
    }

    const malformed: unknown[] = [
      [],
      { v: 2, channelId: 'c1', savedAt: 10, messages: [], tombstones: [] },
      { v: 1, channelId: 'other', savedAt: 10, messages: [], tombstones: [] },
      { v: 1, channelId: 'c1', savedAt: null, messages: [], tombstones: [] },
      { v: 1, channelId: 'c1', savedAt: 10, messages: {}, tombstones: [] },
      { v: 1, channelId: 'c1', savedAt: 10, messages: [], tombstones: {} },
    ];

    for (const value of malformed) {
      const { repository, store } = repo();
      await store.putJson('history', 'channel:c1', value, 10);
      await expect(repository.read('c1', 10)).rejects.toThrow('Invalid local-first history snapshot');
    }
  });

  it('covers append/update/merge no-op safety boundaries and explicit clear', async () => {
    const { repository } = repo();

    await expect(repository.append('c1', null, 1)).resolves.toBeNull();
    await expect(repository.update('c1', message('missing', 1), 1)).resolves.toBeNull();

    await repository.replaceFromServer('c1', [message('known', 2)], 2);
    const unchanged = await repository.update('c1', message('unknown', 3), 3);
    expect(unchanged?.messages.map(row => row._id)).toEqual(['known']);

    await repository.tombstone('c1', 'gone', 4);
    const afterTombstoneAppend = await repository.append('c1', message('gone', 5), 5);
    expect(afterTombstoneAppend?.messages.some(row => row._id === 'gone')).toBe(false);

    const afterTombstoneUpdate = await repository.update('c1', message('gone', 6), 6);
    expect(afterTombstoneUpdate?.messages.some(row => row._id === 'gone')).toBe(false);

    await repository.mergeOlder('c1', [message('older', 1), message('known', 2, { content: 'merged' })], 7);
    const merged = await repository.read('c1', 7);
    expect(merged?.messages.map(row => row._id)).toEqual(['older', 'known']);
    expect(merged?.messages.find(row => row._id === 'known')?.content).toBe('merged');

    await repository.clearChannel('c1');
    await expect(repository.read('c1', 8)).resolves.toBeNull();
  });

  it('listAll rejects physical/history identity mismatches and removes expired rows', async () => {
    {
      const { repository, store } = repo();
      await store.putJson('history', 'wrong-record', {
        v: 1, channelId: 'c1', savedAt: 10, messages: [], tombstones: [],
      }, 10);
      await expect(repository.listAll(10)).rejects.toThrow('record id mismatch');
    }

    {
      const { repository, store } = repo();
      await store.putJson('history', 'bad-value', null, 10);
      await expect(repository.listAll(10)).rejects.toThrow('Invalid local-first history snapshot');
    }

    {
      const { repository, store } = repo();
      await store.putJson('history', 'bad-channel', {
        v: 1, channelId: '', savedAt: 10, messages: [], tombstones: [],
      }, 10);
      await expect(repository.listAll(10)).rejects.toThrow('Invalid local-first history channel');
    }

    {
      const { repository } = repo();
      await repository.replaceFromServer('older', [message('a', 1, { channelId: 'older' })], 10);
      await repository.replaceFromServer('newer', [message('b', 2, { channelId: 'newer' })], 20);
      await expect(repository.listAll(20)).resolves.toMatchObject([
        { channelId: 'newer' },
        { channelId: 'older' },
      ]);
      await expect(repository.listAll(LOCAL_HISTORY_MAX_AGE_MS + 21)).resolves.toEqual([]);
    }
  });

  it('validates channel and message identifiers at the storage boundary', async () => {
    const { repository } = repo();
    await expect(repository.read('')).rejects.toThrow('channelId is required');
    await expect(repository.read('x'.repeat(513))).rejects.toThrow('channelId is too large');
    await expect(repository.tombstone('c1', '')).rejects.toThrow('messageId is required');
    await expect(repository.tombstone('c1', 'x'.repeat(513))).rejects.toThrow('messageId is too large');
  });
});

describe('P7 encrypted history — authority and resurrection boundaries', () => {
  it('never caches optimistic, failed, deleted or foreign-channel messages', async () => {
    const { repository } = repo();
    for (const bad of [
      message('pending:a1', 1),
      message('m-pending', 1, { pending: true }),
      message('m-failed', 1, { failed: true }),
      message('m-deleted', 1, { deletedAt: 5 }),
      message('m-other', 1, { channelId: 'c2' }),
      { channelId: 'c1', content: 'no id', createdAt: 1 },
    ]) {
      await expect(repository.append('c1', bad as never, 10)).resolves.toBeNull();
    }
    await expect(repository.read('c1', 10)).resolves.toBeNull();
  });

  it('a delete learned before any history exists still blocks the deleted message later', async () => {
    const { repository } = repo();
    await repository.tombstone('c1', 'gone', 10);
    await repository.mergeOlder('c1', [message('gone', 1), message('kept', 2)], 11);
    const snapshot = await repository.read('c1', 12);
    expect(snapshot?.messages.map(m => m._id)).toEqual(['kept']);
    expect(snapshot?.tombstones.map(t => t.id)).toContain('gone');
  });

  it('older pages merge into an empty channel in chronological order, ties broken by id', async () => {
    const { repository } = repo();
    await repository.mergeOlder('c1', [message('b', 5), message('a', 5), message('z', 1)], 10);
    await expect(repository.read('c1', 10)).resolves.toMatchObject({
      messages: [{ _id: 'z' }, { _id: 'a' }, { _id: 'b' }],
    });
  });

  it('lists snapshots newest first and refuses a blank channel id', async () => {
    const { repository } = repo();
    await repository.replaceFromServer('c1', [message('x', 1)], 10);
    await repository.replaceFromServer('c2', [message('y', 1, { channelId: 'c2' })], 20);
    await expect(repository.listAll(30)).resolves.toMatchObject([{ channelId: 'c2' }, { channelId: 'c1' }]);
    await expect(repository.read('  ', 30)).rejects.toThrow('channelId');
  });
});
