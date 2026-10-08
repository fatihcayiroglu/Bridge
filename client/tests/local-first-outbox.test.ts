import { describe, expect, it, vi } from 'vitest';
import type { OutboxEntry } from '../js/core/outbox-store.ts';
import {
  EncryptedOutboxRepository,
  validLocalOutboxEntry,
  type LegacyOutboxSource,
} from '../js/core/local-first/outbox.ts';
import {
  EncryptedLocalStore,
  MemoryKeyProvider,
  MemoryRecordBackend,
} from '../js/core/local-first/store.ts';

function entry(
  ackId: string,
  state: OutboxEntry['state'] = 'queued',
  createdAt = 1,
): OutboxEntry {
  return {
    ackId,
    userId: 'u1',
    channelId: 'c1',
    serverId: 's1',
    draftKind: 'channel',
    messageType: 'normal',
    content: `message-${ackId}`,
    createdAt,
    state,
    attempts: 0,
  };
}

function repo(): { repository: EncryptedOutboxRepository; backend: MemoryRecordBackend } {
  const backend = new MemoryRecordBackend();
  const store = new EncryptedLocalStore('u1', backend, new MemoryKeyProvider());
  return { repository: new EncryptedOutboxRepository('u1', store), backend };
}

function legacy(initial: OutboxEntry[]): LegacyOutboxSource & {
  current: OutboxEntry[];
  clear: ReturnType<typeof vi.fn>;
} {
  const state = {
    current: initial,
    read: () => state.current.map(value => structuredClone(value)),
    clear: vi.fn(() => { state.current = []; }),
  };
  return state;
}

describe('P7 encrypted outbox repository', () => {
  it('persists reactive Proxy outbox entries and reply previews as JSON snapshots', async () => {
    const { repository } = repo();
    const replyPreview = new Proxy({ _id: 'reply-1', displayName: 'Alice', content: 'hello' }, {});
    const reactive = new Proxy({ ...entry('proxy'), replyPreview }, {});
    expect(() => structuredClone(reactive)).toThrow();

    await repository.put(reactive);
    const stored = await repository.read();
    expect(stored).toMatchObject([{ ackId: 'proxy', replyPreview: { _id: 'reply-1' } }]);
    await repository.patch('proxy', { state: 'sending', attempts: 1 });
    await expect(repository.read()).resolves.toMatchObject([{ state: 'sending', attempts: 1 }]);
  });

  it('round-trips queue state and preserves ackId ordering', async () => {
    const { repository } = repo();

    await repository.write([
      entry('b', 'failed', 20),
      entry('a', 'sending', 10),
    ]);

    await expect(repository.read()).resolves.toEqual([
      entry('a', 'sending', 10),
      entry('b', 'failed', 20),
    ]);
  });

  it('stores queue plaintext only inside the encrypted envelope', async () => {
    const { repository, backend } = repo();
    await repository.write([entry('secret-ack')]);

    const rows = await backend.listByPrefix('u:u1|n:outbox|');
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('message-secret-ack');
    expect(JSON.stringify(rows)).not.toContain('secret-ack');
  });

  it('process restart converts sending to queued without changing ackId', async () => {
    const { repository } = repo();
    await repository.write([entry('same-id', 'sending')]);

    await expect(repository.restoreAfterRestart()).resolves.toEqual([
      entry('same-id', 'queued'),
    ]);
  });

  it('patches delivery state without creating a second queue item', async () => {
    const { repository } = repo();
    await repository.put(entry('ack-1'));

    await expect(repository.patch('ack-1', {
      state: 'failed',
      attempts: 2,
      lastError: 'timeout',
    })).resolves.toMatchObject({
      ackId: 'ack-1',
      state: 'failed',
      attempts: 2,
      lastError: 'timeout',
    });

    await expect(repository.read()).resolves.toHaveLength(1);
  });

  it('copy-verifies legacy queue before deleting plaintext source', async () => {
    const { repository } = repo();
    const old = legacy([entry('legacy-1'), entry('legacy-2', 'failed', 2)]);

    await expect(repository.migrateLegacy(old)).resolves.toMatchObject({
      status: 'migrated',
      entries: [{ ackId: 'legacy-1' }, { ackId: 'legacy-2' }],
    });
    expect(old.clear).toHaveBeenCalledOnce();
    await expect(repository.read()).resolves.toHaveLength(2);
  });

  it('leaves conflicting plaintext untouched instead of guessing queue freshness', async () => {
    const { repository } = repo();
    await repository.write([entry('encrypted')]);
    const old = legacy([entry('legacy')]);

    await expect(repository.migrateLegacy(old)).resolves.toMatchObject({
      status: 'conflict',
      entries: [{ ackId: 'encrypted' }],
    });
    expect(old.clear).not.toHaveBeenCalled();
    expect(old.current).toHaveLength(1);
  });

  it('rejects duplicate ackIds and cross-account records', async () => {
    const { repository } = repo();

    await expect(repository.write([entry('dup'), entry('dup')])).rejects.toThrow('Duplicate');
    await expect(repository.write([{ ...entry('x'), userId: 'u2' }])).rejects.toThrow('Invalid');
  });

  it('fails closed on malformed queue fields while accepting complete reply/file/sticker shapes', () => {
    const base = entry('valid');
    const invalid: unknown[] = [
      null,
      [],
      { ...base, userId: 'other' },
      { ...base, ackId: '' },
      { ...base, ackId: 'x'.repeat(65) },
      { ...base, channelId: '' },
      { ...base, serverId: '' },
      { ...base, state: 'unknown' },
      { ...base, messageType: 'unknown' },
      { ...base, draftKind: 'unknown' },
      { ...base, content: 1 },
      { ...base, content: 'x'.repeat(2001) },
      { ...base, createdAt: Number.NaN },
      { ...base, createdAt: -1 },
      { ...base, attempts: Number.NaN },
      { ...base, attempts: -1 },
      { ...base, lastAttemptAt: Number.NaN },
      { ...base, lastError: 1 },
      { ...base, replyToId: 1 },
      { ...base, replyPreview: null },
      { ...base, replyPreview: { _id: '' } },
      { ...base, replyPreview: { _id: 'm1', displayName: 1 } },
      { ...base, replyPreview: { _id: 'm1', content: 1 } },
      { ...base, messageType: 'file', fileName: 'x.txt' },
      { ...base, messageType: 'file', fileUrl: '/uploads/x.txt' },
      { ...base, messageType: 'file', fileUrl: '/uploads/x.txt', fileName: 'x.txt', fileType: 1 },
      { ...base, messageType: 'sticker', stickerId: 'st1' },
      { ...base, messageType: 'sticker', stickerPackId: 'p1' },
      { ...base, messageType: 'sticker', stickerPackId: 'p1', stickerId: 'st1', stickerSnapshot: null },
      {
        ...base,
        messageType: 'sticker',
        stickerPackId: 'p1',
        stickerId: 'st1',
        stickerSnapshot: { id: 1, packId: 'p1', name: 'n', url: '/u', width: 1, height: 1 },
      },
      {
        ...base,
        messageType: 'sticker',
        stickerPackId: 'p1',
        stickerId: 'st1',
        stickerSnapshot: { id: 'st1', packId: 1, name: 'n', url: '/u', width: 1, height: 1 },
      },
      {
        ...base,
        messageType: 'sticker',
        stickerPackId: 'p1',
        stickerId: 'st1',
        stickerSnapshot: { id: 'st1', packId: 'p1', name: 1, url: '/u', width: 1, height: 1 },
      },
      {
        ...base,
        messageType: 'sticker',
        stickerPackId: 'p1',
        stickerId: 'st1',
        stickerSnapshot: { id: 'st1', packId: 'p1', name: 'n', url: 1, width: 1, height: 1 },
      },
      {
        ...base,
        messageType: 'sticker',
        stickerPackId: 'p1',
        stickerId: 'st1',
        stickerSnapshot: { id: 'st1', packId: 'p1', name: 'n', url: '/u', width: Number.NaN, height: 1 },
      },
      {
        ...base,
        messageType: 'sticker',
        stickerPackId: 'p1',
        stickerId: 'st1',
        stickerSnapshot: { id: 'st1', packId: 'p1', name: 'n', url: '/u', width: 1, height: Number.NaN },
      },
    ];

    for (const value of invalid) expect(validLocalOutboxEntry(value, 'u1')).toBe(false);

    expect(validLocalOutboxEntry({
      ...base,
      replyToId: 'm0',
      replyPreview: { _id: 'm0', displayName: 'Alice', content: 'preview' },
      lastAttemptAt: 5,
      lastError: 'retry',
    }, 'u1')).toBe(true);

    expect(validLocalOutboxEntry({
      ...base,
      messageType: 'file',
      fileUrl: '/uploads/x.txt',
      fileName: 'x.txt',
      fileType: 'text/plain',
    }, 'u1')).toBe(true);

    expect(validLocalOutboxEntry({
      ...base,
      messageType: 'sticker',
      stickerPackId: 'p1',
      stickerId: 'st1',
      stickerSnapshot: {
        id: 'st1', packId: 'p1', name: 'wave', url: '/uploads/stickers/wave.webp',
        width: 160, height: 160,
      },
    }, 'u1')).toBe(true);
  });

  it('covers empty, missing, update, remove and migration cleanup boundaries', async () => {
    const { repository } = repo();

    await expect(repository.read()).resolves.toEqual([]);
    await expect(repository.write([])).resolves.toEqual([]);
    await expect(repository.patch('missing', { state: 'failed' })).resolves.toBeNull();

    await repository.put(entry('same', 'queued', 2));
    await repository.put(entry('same', 'failed', 2));
    await expect(repository.read()).resolves.toMatchObject([{ ackId: 'same', state: 'failed' }]);

    await expect(repository.patch('same', { attempts: -1 })).rejects.toThrow('Invalid local-first outbox patch');

    await repository.remove('same');
    await expect(repository.read()).resolves.toEqual([]);

    const empty = legacy([]);
    await expect(repository.migrateLegacy(empty)).resolves.toEqual({
      status: 'nothing-to-migrate',
      entries: [],
    });

    await repository.write([entry('encrypted')]);
    await expect(repository.migrateLegacy(legacy([]))).resolves.toMatchObject({
      status: 'already-encrypted',
      entries: [{ ackId: 'encrypted' }],
    });
  });

  it('verifies plaintext cleanup when encrypted and legacy queues already match', async () => {
    const { repository } = repo();
    const same = [entry('same')];
    await repository.write(same);
    const old = legacy(same);

    await expect(repository.migrateLegacy(old)).resolves.toMatchObject({
      status: 'already-encrypted',
      entries: [{ ackId: 'same' }],
    });
    expect(old.clear).toHaveBeenCalledOnce();
    expect(old.current).toEqual([]);
  });

  it('refuses to claim migration success when legacy plaintext cannot be cleared', async () => {
    const { repository } = repo();
    const old = legacy([entry('legacy-stuck')]);
    old.clear.mockImplementation(() => undefined);

    await expect(repository.migrateLegacy(old)).rejects.toThrow('cleanup verification failed');
    expect(old.current).toHaveLength(1);
  });

  it('enforces the bounded queue rather than evicting unsent messages', async () => {
    const { repository } = repo();
    const full = Array.from({ length: 100 }, (_, index) =>
      entry(`ack-${index}`, 'queued', index),
    );
    await repository.write(full);

    await expect(repository.put(entry('overflow', 'queued', 101))).rejects.toThrow('full');
    await expect(repository.read()).resolves.toHaveLength(100);
  });
});
