import { describe, expect, it } from 'vitest';
import {
  EncryptedLocalStore,
  LocalFirstCorruptionError,
  MemoryKeyProvider,
  MemoryRecordBackend,
  localRecordId,
  localRecordScope,
} from '../js/core/local-first/store.ts';

describe('P7 encrypted local-first store', () => {
  it('stores only ciphertext at the physical backend and round-trips by account/scope', async () => {
    const backend = new MemoryRecordBackend();
    const keys = new MemoryKeyProvider();
    const store = new EncryptedLocalStore('alice', backend, keys);

    await store.putJson('draft', 'channel:c1', { text: 'gizli taslak' }, 10);

    const raw = await backend.get(localRecordId('alice', 'draft', 'channel:c1'));
    expect(raw).not.toBeNull();
    expect(JSON.stringify(raw)).not.toContain('gizli taslak');
    await expect(store.getJson('draft', 'channel:c1')).resolves.toEqual({ text: 'gizli taslak' });
  });

  it('strictly separates accounts even when they share a physical backend', async () => {
    const backend = new MemoryRecordBackend();
    const keys = new MemoryKeyProvider();
    const alice = new EncryptedLocalStore('alice', backend, keys);
    const bob = new EncryptedLocalStore('bob', backend, keys);

    await alice.putJson('history', 'channel:c1:message:m1', { content: 'alice only' }, 1);

    await expect(bob.getJson('history', 'channel:c1:message:m1')).resolves.toBeNull();
    await expect(alice.getJson('history', 'channel:c1:message:m1')).resolves.toEqual({ content: 'alice only' });
  });

  it('fails closed when encrypted metadata is moved to a different logical record', async () => {
    const backend = new MemoryRecordBackend();
    const keys = new MemoryKeyProvider();
    const store = new EncryptedLocalStore('alice', backend, keys);

    await store.putJson('outbox', 'ack-1', { content: 'once' }, 1);
    const sourceId = localRecordId('alice', 'outbox', 'ack-1');
    const targetId = localRecordId('alice', 'outbox', 'ack-2');
    const row = await backend.get(sourceId);
    expect(row).not.toBeNull();

    backend.corrupt(targetId, {
      ...row!,
      id: targetId,
      recordId: 'ack-2',
    });

    await expect(store.getJson('outbox', 'ack-2')).rejects.toBeInstanceOf(LocalFirstCorruptionError);
  });

  it('lists one namespace in update order without leaking neighboring namespaces', async () => {
    const backend = new MemoryRecordBackend();
    const store = new EncryptedLocalStore('alice', backend, new MemoryKeyProvider());

    await store.putJson('draft', 'c2', { text: 'second' }, 20);
    await store.putJson('history', 'm1', { content: 'not a draft' }, 15);
    await store.putJson('draft', 'c1', { text: 'first' }, 10);

    await expect(store.list<{ text: string }>('draft')).resolves.toEqual([
      { recordId: 'c1', value: { text: 'first' }, updatedAt: 10 },
      { recordId: 'c2', value: { text: 'second' }, updatedAt: 20 },
    ]);
  });

  it('wipes records before deleting the account key and leaves other accounts intact', async () => {
    const backend = new MemoryRecordBackend();
    const keys = new MemoryKeyProvider();
    const alice = new EncryptedLocalStore('alice', backend, keys);
    const bob = new EncryptedLocalStore('bob', backend, keys);

    await alice.putJson('draft', 'c1', { text: 'a' });
    await alice.putJson('outbox', 'ack-1', { content: 'a' });
    await bob.putJson('draft', 'c1', { text: 'b' });

    await alice.wipeAccount();

    await expect(alice.getJson('draft', 'c1')).resolves.toBeNull();
    await expect(alice.getJson('outbox', 'ack-1')).resolves.toBeNull();
    await expect(bob.getJson('draft', 'c1')).resolves.toEqual({ text: 'b' });
  });

  it('coalesces concurrent account key generation so parallel writes stay decryptable', async () => {
    const backend = new MemoryRecordBackend();
    const keys = new MemoryKeyProvider();
    const store = new EncryptedLocalStore('alice', backend, keys);

    const generated = await Promise.all(
      Array.from({ length: 20 }, () => keys.getOrCreate('alice')),
    );
    expect(new Set(generated).size).toBe(1);

    await Promise.all([
      store.putJson('draft', 'a', { text: 'one' }, 1),
      store.putJson('draft', 'b', { text: 'two' }, 2),
      store.putJson('history', 'c', { text: 'three' }, 3),
    ]);

    await expect(store.getJson('draft', 'a')).resolves.toEqual({ text: 'one' });
    await expect(store.getJson('draft', 'b')).resolves.toEqual({ text: 'two' });
    await expect(store.getJson('history', 'c')).resolves.toEqual({ text: 'three' });
  });

  it('validates identifiers and timestamps before persistence', async () => {
    expect(() => new EncryptedLocalStore('', new MemoryRecordBackend(), new MemoryKeyProvider()))
      .toThrow('userId is required');
    expect(() => localRecordId('alice', 'draft', '')).toThrow('recordId is required');
    expect(() => localRecordId('x'.repeat(513), 'draft', 'r')).toThrow('userId is too large');
    expect(() => localRecordScope('alice', 'draft', 'x'.repeat(513))).toThrow('recordId is too large');

    const store = new EncryptedLocalStore('alice', new MemoryRecordBackend(), new MemoryKeyProvider());
    await expect(store.putJson('draft', 'a', {}, -1)).rejects.toThrow('updatedAt is invalid');
    await expect(store.putJson('draft', 'a', {}, Number.NaN)).rejects.toThrow('updatedAt is invalid');
  });

  it('fails closed on forged namespace metadata and ciphertext corruption', async () => {
    const backend = new MemoryRecordBackend();
    const store = new EncryptedLocalStore('alice', backend, new MemoryKeyProvider());

    await store.putJson('draft', 'meta', { text: 'secret' }, 1);
    const metaId = localRecordId('alice', 'draft', 'meta');
    const meta = await backend.get(metaId);
    backend.corrupt(metaId, { ...meta!, namespace: 'history' });
    await expect(store.getJson('draft', 'meta')).rejects.toThrow('metadata is invalid');

    await store.putJson('draft', 'cipher', { text: 'secret' }, 2);
    const cipherId = localRecordId('alice', 'draft', 'cipher');
    const cipher = await backend.get(cipherId);
    backend.corrupt(cipherId, {
      ...cipher!,
      envelope: { ...cipher!.envelope, ct: 'AAAAAAAAAAAAAAAAAAAAAA==' },
    });
    await expect(store.getJson('draft', 'cipher')).rejects.toMatchObject({
      name: 'LocalFirstCorruptionError',
      message: 'Local-first record authentication failed',
    });
  });

  it('rejects a forged row while listing a namespace', async () => {
    const backend = new MemoryRecordBackend();
    const store = new EncryptedLocalStore('alice', backend, new MemoryKeyProvider());
    await store.putJson('history', 'good', { ok: true }, 1);

    const source = await backend.get(localRecordId('alice', 'history', 'good'));
    const forgedId = localRecordId('alice', 'history', 'forged');
    backend.corrupt(forgedId, {
      ...source!,
      id: forgedId,
      recordId: 'forged',
      userId: 'mallory',
    });

    await expect(store.list('history')).rejects.toThrow('namespace contains an invalid record');
  });

  it('invalidates the old key on wipe and creates a fresh one for later writes', async () => {
    const backend = new MemoryRecordBackend();
    const keys = new MemoryKeyProvider();
    const store = new EncryptedLocalStore('alice', backend, keys);
    const first = await keys.getOrCreate('alice');

    await store.putJson('outbox', 'queue', { items: [1] }, 1);
    await store.wipeAccount();

    await expect(store.getJson('outbox', 'queue')).resolves.toBeNull();
    expect(await keys.getOrCreate('alice')).not.toBe(first);
  });

  it('reports memory composition as non-durable instead of pretending persistence', () => {
    const store = new EncryptedLocalStore('alice', new MemoryRecordBackend(), new MemoryKeyProvider());
    expect(store.durable).toBe(false);
    expect(store.backendKind).toBe('memory');
    expect(store.keyProviderKind).toBe('memory');
  });
});
