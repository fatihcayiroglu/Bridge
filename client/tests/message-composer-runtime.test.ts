import { afterEach, beforeEach, vi } from 'vitest';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import {
  composerCurrentChannel,
  composerCurrentUserId,
  currentDraftContextKey,
  loadAttachmentPending,
  saveAttachmentPending,
} from '../js/core/message-composer-runtime.ts';

// `BridgeRegistry` KANONIK yuzeyi: register / unregister / call / get / has.
// `clear()` YOKTUR ve bilerek yoktur: uygulamanin tum baglantisini tek
// cagriyla silebilen genel bir anahtar, uretimde ayak kurgusudur. Test
// yalnizca KENDI kaydettigi anahtarlari geri alir.
const OWNED_KEYS = [
  'getCurrentChannel', 'getMe',
  'setDraftAttachmentPending', 'getDraftAttachmentPending',
];

describe('message composer registry boundary', () => {
  beforeEach(() => {
    for (const key of OWNED_KEYS) BridgeRegistry.unregister(key);
  });
  afterEach(() => {
    for (const key of OWNED_KEYS) BridgeRegistry.unregister(key);
  });

  it('reads canonical channel/user owners and derives a stable draft context key', () => {
    BridgeRegistry.register('getCurrentChannel', (() => ({ _id: 'c1', serverId: 's1', type: 'text' })) as never);
    BridgeRegistry.register('getMe', (() => ({ _id: 'u1' })) as never);
    expect(composerCurrentChannel()?._id).toBe('c1');
    expect(composerCurrentUserId()).toBe('u1');
    expect(currentDraftContextKey()).toBe('u1:channel:s1:c1');
  });

  it('keeps attachment-pending persistence optional and registry-owned', () => {
    const setPending = vi.fn();
    BridgeRegistry.register('setDraftAttachmentPending', setPending as never);
    BridgeRegistry.register('getDraftAttachmentPending', (() => true) as never);
    saveAttachmentPending(true);
    expect(setPending).toHaveBeenCalledWith(true);
    expect(loadAttachmentPending()).toBe(true);
  });
});
