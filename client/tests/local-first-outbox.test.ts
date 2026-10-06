import { describe, expect, it, vi } from 'vitest';
import type { OutboxEntry } from '../js/core/outbox-store.ts';
import {
  EncryptedOutboxRepository,
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
