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
  return { repository: new EncryptedHistoryRepository(store), backend };
}

function message(id: string, createdAt: number, extra: Record<string, unknown> = {}) {
  return { _id: id, channelId: 'c1', content: `secret-${id}`, createdAt, ...extra };
}

describe('P7 encrypted message history', () => {
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
});
