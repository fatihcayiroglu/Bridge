import { describe, expect, it, vi } from 'vitest';
import type { DraftIdentity } from '../js/core/draft-store.ts';
import {
  EncryptedDraftRepository,
  LOCAL_DRAFT_MAX_AGE_MS,
  type LegacyDraftSource,
  type LocalDraftSnapshot,
} from '../js/core/local-first/drafts.ts';
import {
  EncryptedLocalStore,
  MemoryKeyProvider,
  MemoryRecordBackend,
} from '../js/core/local-first/store.ts';

const identity: DraftIdentity = {
  userId: 'u1',
  kind: 'channel',
  serverId: 's1',
  conversationId: 'c1',
};

function repo(): EncryptedDraftRepository {
  return new EncryptedDraftRepository(
    new EncryptedLocalStore('u1', new MemoryRecordBackend(), new MemoryKeyProvider()),
  );
}

function legacy(snapshot: LocalDraftSnapshot | null): LegacyDraftSource & { clear: ReturnType<typeof vi.fn> } {
  const clear = vi.fn();
  return {
    read: () => snapshot,
    clear,
  };
}

describe('P7 encrypted draft repository', () => {
  it('stores text and attachment recovery state together', async () => {
    const drafts = repo();

    await drafts.write(identity, 'yarım mesaj', true, 123);

    await expect(drafts.read(identity, 123)).resolves.toEqual({
      v: 1,
      text: 'yarım mesaj',
      savedAt: 123,
      attachmentPending: true,
    });
  });

  it('empty text without attachment removes the record', async () => {
    const drafts = repo();
    await drafts.write(identity, 'önce', false, 10);

    await expect(drafts.write(identity, '   ', false, 20)).resolves.toBeNull();
    await expect(drafts.read(identity, 20)).resolves.toBeNull();
  });

  it('keeps an attachment-only recovery marker', async () => {
    const drafts = repo();

    await drafts.write(identity, '', true, 10);

    await expect(drafts.read(identity, 10)).resolves.toMatchObject({
      text: '',
      attachmentPending: true,
    });
  });

  it('copy-verifies encrypted migration before deleting plaintext legacy state', async () => {
    const drafts = repo();
    const old = legacy({
      v: 1,
      text: 'legacy plaintext',
      savedAt: 100,
      attachmentPending: false,
    });

    await expect(drafts.migrateLegacy(identity, old, 100)).resolves.toMatchObject({
      status: 'migrated',
      snapshot: { text: 'legacy plaintext' },
    });
    expect(old.clear).toHaveBeenCalledOnce();
    await expect(drafts.read(identity, 100)).resolves.toMatchObject({ text: 'legacy plaintext' });
  });

  it('does not delete legacy data when encrypted write/verification fails', async () => {
    const backend = new MemoryRecordBackend();
    const store = new EncryptedLocalStore('u1', backend, new MemoryKeyProvider());
    const drafts = new EncryptedDraftRepository(store);
    const old = legacy({
      v: 1,
      text: 'korunmalı',
      savedAt: 100,
      attachmentPending: false,
    });
    vi.spyOn(store, 'getJson')
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('corrupt after write'));

    await expect(drafts.migrateLegacy(identity, old, 100)).rejects.toThrow();
    expect(old.clear).not.toHaveBeenCalled();
  });

  it('expires stale encrypted drafts', async () => {
    const drafts = repo();
    await drafts.write(identity, 'çok eski', false, 1);

    await expect(drafts.read(identity, LOCAL_DRAFT_MAX_AGE_MS + 2)).resolves.toBeNull();
    await expect(drafts.read(identity, LOCAL_DRAFT_MAX_AGE_MS + 2)).resolves.toBeNull();
  });
});
