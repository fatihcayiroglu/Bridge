import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DRAFT_KEY_PREFIX,
  draftKey,
  writeDraft,
  type DraftIdentity,
} from '../js/core/draft-store.ts';
import {
  closeLocalFirstDraftRuntime,
  flushLocalFirstDraft,
  hydrateLocalFirstDraft,
  peekLocalFirstDraft,
  persistLocalFirstDraftAttachment,
  persistLocalFirstDraftText,
  resetLocalFirstDraftRuntimeForTests,
} from '../js/core/local-first/draft-runtime.ts';

const A: DraftIdentity = {
  userId: 'user-a',
  kind: 'channel',
  serverId: 'server-1',
  conversationId: 'channel-1',
};
const B: DraftIdentity = {
  userId: 'user-b',
  kind: 'channel',
  serverId: 'server-1',
  conversationId: 'channel-1',
};

beforeEach(() => {
  localStorage.clear();
  resetLocalFirstDraftRuntimeForTests();
});

afterEach(() => {
  resetLocalFirstDraftRuntimeForTests();
  localStorage.clear();
});

describe('P7 shared local-first draft runtime', () => {
  it('migrates legacy plaintext then removes the legacy key', async () => {
    writeDraft(A, 'eski plaintext');
    const key = draftKey(A)!;
    expect(localStorage.getItem(key)).toContain('eski plaintext');

    await expect(hydrateLocalFirstDraft(A)).resolves.toMatchObject({
      text: 'eski plaintext',
    });

    expect(localStorage.getItem(key)).toBeNull();
    expect(peekLocalFirstDraft(A)?.text).toBe('eski plaintext');
  });

  it('new draft writes do not create a legacy plaintext localStorage record', async () => {
    persistLocalFirstDraftText(A, 'yalnız şifreli');
    await flushLocalFirstDraft(A);

    const legacyKeys = Object.keys(localStorage)
      .filter(key => key.startsWith(DRAFT_KEY_PREFIX));
    expect(legacyKeys).toEqual([]);
    expect(JSON.stringify(localStorage)).not.toContain('yalnız şifreli');
  });

  it('preserves attachment recovery state when text changes', async () => {
    persistLocalFirstDraftAttachment(A, true, 10);
    persistLocalFirstDraftText(A, 'metin', 20);
    await flushLocalFirstDraft(A);

    expect(peekLocalFirstDraft(A)).toMatchObject({
      text: 'metin',
      attachmentPending: true,
    });
  });

  it('isolates accounts in the synchronous cache', async () => {
    persistLocalFirstDraftText(A, 'A özel');
    persistLocalFirstDraftText(B, 'B özel');
    await Promise.all([flushLocalFirstDraft(A), flushLocalFirstDraft(B)]);

    expect(peekLocalFirstDraft(A)?.text).toBe('A özel');
    expect(peekLocalFirstDraft(B)?.text).toBe('B özel');
  });

  it('logout drops active in-memory state and never exposes it through another account', async () => {
    persistLocalFirstDraftText(A, 'A oturum verisi');
    await flushLocalFirstDraft(A);

    closeLocalFirstDraftRuntime(A.userId);

    expect(peekLocalFirstDraft(A)).toBeNull();
    expect(peekLocalFirstDraft(B)).toBeNull();
  });
});

describe('P7 draft runtime account isolation and boundaries', () => {
  it('logout of one account purges only that account\'s in-memory drafts', async () => {
    persistLocalFirstDraftText(A, 'alice private draft', Date.now());
    persistLocalFirstDraftText(B, 'bob private draft', Date.now());
    await flushLocalFirstDraft(A);
    await flushLocalFirstDraft(B);

    closeLocalFirstDraftRuntime(A.userId);

    // Nothing of A survives in memory (no plaintext fallback exists either).
    expect(peekLocalFirstDraft(A)).toBeNull();
    // B's session is untouched by A's logout.
    expect(peekLocalFirstDraft(B)?.text).toBe('bob private draft');
    expect(() => closeLocalFirstDraftRuntime('')).not.toThrow();
  });

  it('refuses incomplete identities at every public entry point', async () => {
    const noConversation = { ...A, conversationId: '' };
    const channelWithoutServer = { userId: 'user-a', kind: 'channel', conversationId: 'c' } as DraftIdentity;
    expect(() => peekLocalFirstDraft(noConversation)).toThrow('incomplete');
    expect(() => peekLocalFirstDraft(channelWithoutServer)).toThrow('requires serverId');
    expect(() => persistLocalFirstDraftText(noConversation, 'x')).toThrow('incomplete');
    await expect(hydrateLocalFirstDraft(channelWithoutServer)).rejects.toThrow('requires serverId');
  });

  it('a whitespace-only draft without an attachment is an empty draft; text is bounded', () => {
    expect(persistLocalFirstDraftText(A, '   ', Date.now())).toBeNull();
    expect(peekLocalFirstDraft(A)).toBeNull();
    const long = persistLocalFirstDraftText(A, 'z'.repeat(2_500), Date.now());
    expect(long?.text).toHaveLength(2_000);
  });

  it('hydration that loses a race to newer typing returns the newer in-session text', async () => {
    const hydrating = hydrateLocalFirstDraft(A);
    persistLocalFirstDraftText(A, 'typed while loading', Date.now());
    await expect(hydrating).resolves.toMatchObject({ text: 'typed while loading' });
  });
});
