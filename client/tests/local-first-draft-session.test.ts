import { describe, expect, it, vi } from 'vitest';
import type { DraftIdentity } from '../js/core/draft-store.ts';
import {
  LocalFirstDraftSession,
} from '../js/core/local-first/draft-session.ts';
import {
  EncryptedDraftRepository,
  type LegacyDraftSource,
  type LocalDraftSnapshot,
} from '../js/core/local-first/drafts.ts';
import {
  EncryptedLocalStore,
  MemoryKeyProvider,
  MemoryRecordBackend,
} from '../js/core/local-first/store.ts';

const A: DraftIdentity = {
  userId: 'u1',
  kind: 'channel',
  serverId: 's1',
  conversationId: 'c1',
};

function makeLegacy(initial: LocalDraftSnapshot | null = null): LegacyDraftSource & {
  current: LocalDraftSnapshot | null;
  clear: ReturnType<typeof vi.fn>;
} {
  const state = {
    current: initial,
    clear: vi.fn(() => { state.current = null; }),
    read: () => state.current,
  };
  return state;
}

function makeSession(legacy: LegacyDraftSource, events = {}) {
  const store = new EncryptedLocalStore('u1', new MemoryRecordBackend(), new MemoryKeyProvider());
  const repository = new EncryptedDraftRepository(store);
  return { session: new LocalFirstDraftSession(repository, legacy, events), repository };
}

describe('P7 local-first draft session', () => {
  it('gives UI an immediate value while encrypted persistence stays async', async () => {
    const legacy = makeLegacy();
    const { session, repository } = makeSession(legacy);

    const value = session.set(A, 'anında görünür', false, 10);

    expect(value?.text).toBe('anında görünür');
    expect(session.peek(A)?.text).toBe('anında görünür');

    await session.flush(A);
    await expect(repository.read(A, 10)).resolves.toMatchObject({ text: 'anında görünür' });
  });

  it('hydrates and removes legacy plaintext only after verified encrypted migration', async () => {
    const savedAt = Date.now();
    const legacy = makeLegacy({
      v: 1,
      text: 'eski taslak',
      savedAt,
      attachmentPending: false,
    });
    const onHydrated = vi.fn();
    const { session, repository } = makeSession(legacy, { onHydrated });

    await expect(session.hydrate(A)).resolves.toMatchObject({ text: 'eski taslak' });

    expect(legacy.clear).toHaveBeenCalledOnce();
    expect(onHydrated).toHaveBeenCalledOnce();
    await expect(repository.read(A, savedAt)).resolves.toMatchObject({ text: 'eski taslak' });
  });

  it('a slow hydration cannot overwrite newer user input', async () => {
    const legacy = makeLegacy({
      v: 1,
      text: 'eski',
      savedAt: 1,
      attachmentPending: false,
    });
    const { session } = makeSession(legacy);

    const hydration = session.hydrate(A);
    session.set(A, 'yeni', false, 2);

    await hydration;
    await session.flush(A);
    expect(session.peek(A)?.text).toBe('yeni');
  });

  it('serializes rapid writes so the newest value wins on disk', async () => {
    const legacy = makeLegacy();
    const { session, repository } = makeSession(legacy);

    session.set(A, 'a', false, 1);
    session.set(A, 'ab', false, 2);
    session.set(A, 'abc', false, 3);

    await session.flush(A);

    expect(session.peek(A)?.text).toBe('abc');
    await expect(repository.read(A, 3)).resolves.toMatchObject({
      text: 'abc',
      savedAt: 3,
    });
  });

  it('does not clear legacy plaintext when encrypted persistence fails', async () => {
    const legacy = makeLegacy({
      v: 1,
      text: 'korunacak',
      savedAt: 1,
      attachmentPending: false,
    });
    const store = new EncryptedLocalStore('u1', new MemoryRecordBackend(), new MemoryKeyProvider());
    const repository = new EncryptedDraftRepository(store);
    vi.spyOn(repository, 'write').mockRejectedValueOnce(new Error('disk failed'));
    const onPersistenceError = vi.fn();
    const session = new LocalFirstDraftSession(repository, legacy, { onPersistenceError });

    session.set(A, 'yeni ama yazılamadı', false, 2);
    await session.flush(A);

    expect(onPersistenceError).toHaveBeenCalledOnce();
    expect(legacy.clear).not.toHaveBeenCalled();
    expect(legacy.current?.text).toBe('korunacak');
    expect(session.peek(A)?.text).toBe('yeni ama yazılamadı');
  });

  it('clear is immediate to UI and removes both encrypted and legacy copies in order', async () => {
    const legacy = makeLegacy({
      v: 1,
      text: 'silinecek',
      savedAt: 1,
      attachmentPending: true,
    });
    const { session, repository } = makeSession(legacy);

    await session.hydrate(A);
    session.clear(A);
    expect(session.peek(A)).toBeNull();

    await session.flush(A);
    await expect(repository.read(A)).resolves.toBeNull();
    expect(legacy.current).toBeNull();
  });
});
