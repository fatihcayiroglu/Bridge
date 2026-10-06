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

  it('logout drops active in-memory state without deleting persisted encrypted state', async () => {
    persistLocalFirstDraftText(A, 'geri gelecek');
    await flushLocalFirstDraft(A);

    closeLocalFirstDraftRuntime(A.userId);
    expect(peekLocalFirstDraft(A)).toBeNull();

    await expect(hydrateLocalFirstDraft(A)).resolves.toMatchObject({
      text: 'geri gelecek',
    });
  });
});
