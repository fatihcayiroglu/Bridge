// P7 A3 — encrypted draft repository: identity validation, corrupt/stale
// record handling and the copy → verify → delete legacy migration contract
// (plaintext is never removed unless the encrypted copy reads back equal).

import { describe, expect, it, vi } from 'vitest';
import type { DraftIdentity } from '../js/core/draft-store.ts';
import {
  EncryptedDraftRepository,
  LOCAL_DRAFT_MAX_AGE_MS,
  LOCAL_DRAFT_MAX_LENGTH,
  localDraftRecordId,
  type LocalDraftSnapshot,
} from '../js/core/local-first/drafts.ts';
import { EncryptedLocalStore, MemoryKeyProvider, MemoryRecordBackend } from '../js/core/local-first/store.ts';

const CH: DraftIdentity = { userId: 'u1', kind: 'channel', serverId: 's1', conversationId: 'c1' };
const DM: DraftIdentity = { userId: 'u1', kind: 'dm', conversationId: 'd1' };

function makeRepo() {
  const store = new EncryptedLocalStore('u1', new MemoryRecordBackend(), new MemoryKeyProvider());
  return { repo: new EncryptedDraftRepository(store), store };
}

function legacyOf(value: unknown) {
  return { read: vi.fn(() => value as LocalDraftSnapshot | null), clear: vi.fn() };
}

describe('P7 draft identity validation', () => {
  it.each([
    ['no user', { ...CH, userId: '' }, 'incomplete'],
    ['no conversation', { ...CH, conversationId: '' }, 'incomplete'],
    ['unknown kind', { ...CH, kind: 'thread' }, 'kind is invalid'],
    ['channel without server', { userId: 'u1', kind: 'channel', conversationId: 'c1' }, 'requires serverId'],
  ])('refuses an identity with %s', async (_name, identity, message) => {
    const { repo } = makeRepo();
    expect(() => localDraftRecordId(identity as DraftIdentity)).toThrow(message);
    await expect(repo.read(identity as DraftIdentity)).rejects.toThrow(message);
    await expect(repo.write(identity as DraftIdentity, 'x', false)).rejects.toThrow(message);
  });

  it('record ids are scoped by kind/server and escape separators so ids cannot collide', () => {
    expect(localDraftRecordId(DM)).toBe('dm:dm:d1');
    expect(localDraftRecordId({ userId: 'u1', kind: 'gdm', conversationId: 'g1' })).toBe('gdm:gdm:g1');
    const a = localDraftRecordId({ ...CH, serverId: 's:1', conversationId: 'c' });
    const b = localDraftRecordId({ ...CH, serverId: 's', conversationId: '1:c' });
    expect(a).not.toBe(b);
  });
});

describe('P7 draft records fail closed and stay bounded', () => {
  it.each([
    ['an array', []],
    ['a wrong version', { v: 2, text: 'x', savedAt: 1, attachmentPending: false }],
    ['non-string text', { v: 1, text: 5, savedAt: 1, attachmentPending: false }],
    ['a negative timestamp', { v: 1, text: 'x', savedAt: -1, attachmentPending: false }],
    ['a non-boolean attachment flag', { v: 1, text: 'x', savedAt: 1, attachmentPending: 'yes' }],
  ])('a stored draft with %s reads as empty and is deleted', async (_name, raw) => {
    const { repo, store } = makeRepo();
    await store.putJson('draft', localDraftRecordId(CH), raw, 1);
    await expect(repo.read(CH, 10)).resolves.toBeNull();
    await expect(store.getJson('draft', localDraftRecordId(CH))).resolves.toBeNull();
  });

  it('a draft older than the retention window is dropped on read', async () => {
    const { repo } = makeRepo();
    await repo.write(CH, 'old thought', false, 1_000);
    await expect(repo.read(CH, 1_000 + LOCAL_DRAFT_MAX_AGE_MS + 1)).resolves.toBeNull();
  });

  it('text is truncated to the bound; an empty draft without attachment clears the record', async () => {
    const { repo } = makeRepo();
    const long = await repo.write(DM, 'y'.repeat(LOCAL_DRAFT_MAX_LENGTH + 50), false, 5);
    expect(long?.text).toHaveLength(LOCAL_DRAFT_MAX_LENGTH);
    await expect(repo.write(DM, '   ', false, 6)).resolves.toBeNull();
    await expect(repo.read(DM, 7)).resolves.toBeNull();
    // An attachment-only draft is kept even with no text.
    await expect(repo.write(DM, '', true, 8)).resolves.toMatchObject({ text: '', attachmentPending: true });
    await expect(repo.write(DM, 42 as unknown as string, true, 9)).resolves.toMatchObject({ text: '' });
  });
});

describe('P7 legacy draft migration is copy → verify → delete', () => {
  const now = 10_000;
  const good = { v: 1, text: 'legacy text', savedAt: now - 5, attachmentPending: false };

  it('an existing encrypted draft wins and the legacy source is not consulted', async () => {
    const { repo } = makeRepo();
    await repo.write(CH, 'encrypted', false, now);
    const legacy = legacyOf(good);
    await expect(repo.migrateLegacy(CH, legacy, now)).resolves.toMatchObject({ status: 'already-encrypted' });
    expect(legacy.read).not.toHaveBeenCalled();
    expect(legacy.clear).not.toHaveBeenCalled();
  });

  it.each([
    ['malformed', { v: 1, text: 7, savedAt: 1, attachmentPending: false }],
    ['expired', { ...good, savedAt: now - LOCAL_DRAFT_MAX_AGE_MS - 1 }],
    ['empty', { ...good, text: '  ' }],
  ])('a %s legacy draft is left untouched and nothing is migrated', async (_name, value) => {
    const { repo } = makeRepo();
    const legacy = legacyOf(value);
    await expect(repo.migrateLegacy(CH, legacy, now)).resolves.toEqual({ status: 'nothing-to-migrate', snapshot: null });
    expect(legacy.clear).not.toHaveBeenCalled();
  });

  it('a failed read-back verification keeps the plaintext source', async () => {
    const { repo } = makeRepo();
    const legacy = legacyOf(good);
    const realRead = repo.read.bind(repo);
    let reads = 0;
    vi.spyOn(repo, 'read').mockImplementation(async (identity, at) => {
      reads += 1;
      if (reads === 2) return { ...good, text: 'tampered' } as LocalDraftSnapshot;
      return realRead(identity, at);
    });
    await expect(repo.migrateLegacy(CH, legacy, now)).rejects.toThrow('verification failed');
    expect(legacy.clear).not.toHaveBeenCalled();
  });

  it('a verified copy clears the plaintext source exactly once', async () => {
    const { repo } = makeRepo();
    const legacy = legacyOf(good);
    await expect(repo.migrateLegacy(CH, legacy, now)).resolves.toMatchObject({ status: 'migrated', snapshot: { text: 'legacy text' } });
    expect(legacy.clear).toHaveBeenCalledOnce();
    await expect(repo.read(CH, now)).resolves.toMatchObject({ text: 'legacy text' });
  });
});
