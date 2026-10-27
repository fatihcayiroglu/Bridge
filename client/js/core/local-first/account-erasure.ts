// P7: erase this device's local-first data when the account is deleted.
//
// Deleting an account on the server does not reach the device: the encrypted
// local history, outbox, operation log and drafts of that account, the legacy
// plaintext drafts, and its keys (browser IndexedDB CryptoKey and, on iOS, the
// Keychain key) would otherwise stay behind after logout.
//
// Order matters:
//   1. mark the account erased (persisted) — from here no store for it opens
//      durable storage, no key is created and no record is written, so a
//      delayed draft/outbox/history task cannot re-create data;
//   2. close the account's runtimes (open database handles, session caches);
//   3. delete legacy drafts, remembered navigation, every record under the
//      account prefix, then every key source. Records go before keys, as in
//      EncryptedLocalStore.wipeAccount.
// A failure leaves the mark in place; the startup sweep repeats step 3 for
// every marked account until it succeeds (idempotent), and also removes any
// record an in-flight write managed to land between the mark and the sweep.
//
// The store composition root is deliberately bypassed: it would create a key
// for the account just to delete it, and it selects ONE key provider, while an
// iOS account may hold both a browser key and a native Keychain key.

import { clearLegacyDraftsForUser } from '../draft-store.ts';
import { closeLocalFirstDraftRuntime } from './draft-runtime.ts';
import { closeLocalFirstHistoryRuntime } from './history-runtime.ts';
import { closeLocalFirstOperationRuntime } from './operation-runtime.ts';
import { closeLocalFirstOutboxRuntime } from './outbox-runtime.ts';
import { erasedLocalAccounts, markLocalAccountErased } from './erased-accounts.ts';
import { IndexedDbKeyProvider, IndexedDbRecordBackend } from './indexeddb.ts';
import { iosLocalFirstCipher } from './ios-crypto.ts';
import { localUserPrefix } from './store.ts';
import { forgetNavigationOwner } from '../navigation-selection.ts';

export interface LocalAccountErasureResult {
  /** Every record and key source was removed on this run. */
  erased: boolean;
  /** The erased mark survives a reload (localStorage accepted it). */
  markPersisted: boolean;
}

function hasIndexedDb(): boolean {
  try {
    return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
  } catch {
    return false;
  }
}

/** Step 3 alone: idempotent, safe to repeat for an already-erased account. */
async function sweepAccount(userId: string): Promise<void> {
  clearLegacyDraftsForUser(userId);
  // Remembered server/channel IDs, including the Android native copy (#490).
  if (!await forgetNavigationOwner(userId)) throw new Error('Navigation preferences were not removed');
  if (hasIndexedDb()) {
    const records = new IndexedDbRecordBackend();
    const keys = new IndexedDbKeyProvider();
    try {
      await records.clearPrefix(localUserPrefix(userId));
      await keys.delete(userId);
    } finally {
      records.close();
      keys.close();
    }
  }
  const native = iosLocalFirstCipher(userId);
  if (native) {
    try {
      await native.deleteKey();
    } finally {
      native.close?.();
    }
  }
}

/**
 * Erase this device's local-first data of `userId`. Call after the server
 * confirmed the account deletion and before the session state is torn down.
 * Never throws: the result reports whether the wipe completed now.
 */
export async function eraseLocalAccount(userId: string): Promise<LocalAccountErasureResult> {
  const markPersisted = markLocalAccountErased(userId);
  closeLocalFirstDraftRuntime(userId);
  closeLocalFirstOutboxRuntime(userId);
  closeLocalFirstHistoryRuntime(userId);
  closeLocalFirstOperationRuntime(userId);
  try {
    await sweepAccount(userId);
    return { erased: true, markPersisted };
  } catch {
    return { erased: false, markPersisted };
  }
}

/**
 * Startup sweep: completes interrupted erasures and removes anything an
 * in-flight write landed after the mark. Returns the accounts still pending.
 */
export async function sweepErasedLocalAccounts(): Promise<string[]> {
  const pending: string[] = [];
  for (const userId of erasedLocalAccounts()) {
    try {
      await sweepAccount(userId);
    } catch {
      pending.push(userId);
    }
  }
  return pending;
}
