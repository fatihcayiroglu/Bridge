// P7: deleting an account erases that account's local-first data on the
// device: encrypted records of every namespace, legacy plaintext drafts, the
// browser IndexedDB key and the native (iOS Keychain) key. Delayed writes must
// not re-create data, and an interrupted wipe is completed by the startup sweep.
//
// IndexedDB is redirected to in-memory backends (the real record/key APIs are
// spied, as in local-first-ios-crypto.test.ts); the native plugin is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ getPlatform: vi.fn(), isPluginAvailable: vi.fn() }));
const native = vi.hoisted(() => ({ hasKey: vi.fn(), ensureKey: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(), deleteKey: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: platform }));
vi.mock('@bridge/local-first-crypto', () => ({ BridgeLocalFirstCrypto: native }));

import { eraseLocalAccount, sweepErasedLocalAccounts } from '../js/core/local-first/account-erasure.ts';
import {
  erasedLocalAccounts, isLocalAccountErased, markLocalAccountErased, resetErasedLocalAccountsForTests,
} from '../js/core/local-first/erased-accounts.ts';
import { createBrowserLocalFirstStore, IndexedDbKeyProvider, IndexedDbRecordBackend } from '../js/core/local-first/indexeddb.ts';
import { EncryptedLocalStore, MemoryKeyProvider, MemoryRecordBackend, localRecordId } from '../js/core/local-first/store.ts';
import { DRAFT_KEY_PREFIX } from '../js/core/draft-store.ts';

const ERASED = 'user-erased';
const OTHER = 'user-other';
const STORAGE_KEY = 'bridge:local-first:erased-accounts:v1';

let physical: MemoryRecordBackend;
let browserKeys: Set<string>;
let nativeKeys: Set<string>;

async function seedAccount(userId: string): Promise<EncryptedLocalStore> {
  const store = new EncryptedLocalStore(userId, physical, new MemoryKeyProvider());
  await store.putJson('drafts', 'c1', { text: `${userId} draft` });
  await store.putJson('history', 'h1', { body: `${userId} history` });
  await store.putJson('outbox', 'o1', { body: `${userId} queued` });
  await store.putJson('operations', 'op1', { kind: 'send' });
  browserKeys.add(userId);
  nativeKeys.add(userId);
  localStorage.setItem(`${DRAFT_KEY_PREFIX}:${encodeURIComponent(userId)}:channel:s1:c1`, `{"t":"${userId} legacy"}`);
  return store;
}
const recordIds = async (userId: string) => (await physical.listByPrefix(`u:${encodeURIComponent(userId)}|`)).map(r => r.id);
const legacyKeys = (userId: string) => Object.keys(localStorage).filter(k => k.startsWith(`${DRAFT_KEY_PREFIX}:${encodeURIComponent(userId)}:`));

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  resetErasedLocalAccountsForTests();
  physical = new MemoryRecordBackend();
  browserKeys = new Set();
  nativeKeys = new Set();
  vi.stubGlobal('indexedDB', {});
  platform.getPlatform.mockReturnValue('ios');
  platform.isPluginAvailable.mockReturnValue(true);
  vi.spyOn(IndexedDbRecordBackend.prototype, 'clearPrefix').mockImplementation(prefix => physical.clearPrefix(prefix));
  vi.spyOn(IndexedDbRecordBackend.prototype, 'listByPrefix').mockImplementation(prefix => physical.listByPrefix(prefix));
  vi.spyOn(IndexedDbKeyProvider.prototype, 'delete').mockImplementation(async userId => { browserKeys.delete(userId); });
  native.deleteKey.mockImplementation(async ({ userId }: { userId: string }) => { nativeKeys.delete(userId); });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('account erasure removes the account\'s local-first data and every key', () => {
  it('removes every namespace, the legacy drafts, the browser key and the native key; another account is untouched', async () => {
    await seedAccount(ERASED);
    await seedAccount(OTHER);
    expect(await recordIds(ERASED)).toHaveLength(4);

    expect(await eraseLocalAccount(ERASED)).toEqual({ erased: true, markPersisted: true });

    expect(await recordIds(ERASED)).toEqual([]);
    expect(legacyKeys(ERASED)).toEqual([]);
    expect(browserKeys.has(ERASED)).toBe(false);
    expect(nativeKeys.has(ERASED)).toBe(false);
    expect(native.deleteKey).toHaveBeenCalledWith({ userId: ERASED });
    // The other account keeps everything.
    expect(await recordIds(OTHER)).toHaveLength(4);
    expect(legacyKeys(OTHER)).toHaveLength(1);
    expect(browserKeys.has(OTHER)).toBe(true);
    expect(nativeKeys.has(OTHER)).toBe(true);
  });

  it('deletes records before keys, so a failed record wipe never orphans undecryptable ciphertext', async () => {
    await seedAccount(ERASED);
    const order: string[] = [];
    vi.mocked(IndexedDbRecordBackend.prototype.clearPrefix).mockImplementation(async prefix => { order.push('records'); await physical.clearPrefix(prefix); });
    vi.mocked(IndexedDbKeyProvider.prototype.delete).mockImplementation(async userId => { order.push('browser-key'); browserKeys.delete(userId); });
    native.deleteKey.mockImplementation(async ({ userId }: { userId: string }) => { order.push('native-key'); nativeKeys.delete(userId); });
    await eraseLocalAccount(ERASED);
    expect(order).toEqual(['records', 'browser-key', 'native-key']);
  });

  it('a failed wipe keeps the persisted mark and the keys; the startup sweep completes it', async () => {
    await seedAccount(ERASED);
    vi.mocked(IndexedDbRecordBackend.prototype.clearPrefix).mockRejectedValueOnce(new DOMException('quota', 'QuotaExceededError'));

    expect(await eraseLocalAccount(ERASED)).toEqual({ erased: false, markPersisted: true });
    expect(await recordIds(ERASED)).toHaveLength(4);
    expect(browserKeys.has(ERASED)).toBe(true);          // records first: keys stay while records do
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]')).toEqual([ERASED]);

    // A reload: the in-memory marks are gone, the persisted one is not.
    resetErasedLocalAccountsForTests();
    expect(isLocalAccountErased(ERASED)).toBe(true);
    expect(await sweepErasedLocalAccounts()).toEqual([]);
    expect(await recordIds(ERASED)).toEqual([]);
    expect(browserKeys.has(ERASED)).toBe(false);
    expect(nativeKeys.has(ERASED)).toBe(false);
  });

  it('a write already in flight when the account is erased lands nothing', async () => {
    const store = new EncryptedLocalStore(ERASED, physical, new MemoryKeyProvider());
    // The account is erased while this write is encrypting.
    const write = store.putJson('drafts', 'late', { text: 'typed after deletion' });
    markLocalAccountErased(ERASED);
    await expect(write).rejects.toThrow('Local data for this account was erased');
    expect(await physical.get(localRecordId(ERASED, 'drafts', 'late'))).toBeNull();
  });

  it('a record that still landed after the mark is removed by the startup sweep', async () => {
    await eraseLocalAccount(ERASED);
    // Simulate a write that passed its guard just before the mark.
    await new EncryptedLocalStore(OTHER, physical, new MemoryKeyProvider()).putJson('drafts', 'x', { text: 'other' });
    await physical.put({ ...(await physical.get(localRecordId(OTHER, 'drafts', 'x')))!, id: localRecordId(ERASED, 'drafts', 'late'), userId: ERASED });
    expect(await recordIds(ERASED)).toHaveLength(1);
    await sweepErasedLocalAccounts();
    expect(await recordIds(ERASED)).toEqual([]);
    expect(await recordIds(OTHER)).toHaveLength(1);
  });
});

describe('an erased account never gets durable storage or a key again', () => {
  it('the store composition root returns a non-durable memory store and touches no key provider', async () => {
    const getOrCreate = vi.spyOn(IndexedDbKeyProvider.prototype, 'getOrCreate');
    await eraseLocalAccount(ERASED);
    const opened = await createBrowserLocalFirstStore(ERASED);
    expect(opened).toMatchObject({ durable: false, backend: 'memory', reason: 'Local data for this account was erased' });
    expect(getOrCreate).not.toHaveBeenCalled();
    expect(native.hasKey).not.toHaveBeenCalled();
    expect(native.ensureKey).not.toHaveBeenCalled();
    // Writes into that throwaway store are refused too.
    await expect(opened.store.putJson('drafts', 'd', { text: 'x' })).rejects.toThrow('Local data for this account was erased');
  });

  it('the IndexedDB key provider refuses to create a key for an erased account', async () => {
    vi.mocked(IndexedDbKeyProvider.prototype.delete).mockRestore();
    markLocalAccountErased(ERASED);
    await expect(new IndexedDbKeyProvider().getOrCreate(ERASED)).rejects.toThrow('Local data for this account was erased');
  });

  it('a different account is unaffected by the mark (positive control)', async () => {
    platform.getPlatform.mockReturnValue('web');
    markLocalAccountErased(ERASED);
    vi.spyOn(IndexedDbKeyProvider.prototype, 'getOrCreate').mockResolvedValue({} as CryptoKey);
    const opened = await createBrowserLocalFirstStore(OTHER);
    expect(opened).toMatchObject({ durable: true, backend: 'indexeddb' });
  });
});

describe('the erased-accounts registry', () => {
  it('is persisted, validated and bounded', () => {
    for (let i = 0; i < 70; i += 1) markLocalAccountErased(`u${i}`);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[];
    expect(stored).toHaveLength(64);
    expect(stored[63]).toBe('u69');
    expect(() => markLocalAccountErased('')).toThrow();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['ok', 5, '', null, 'x'.repeat(300)]));
    resetErasedLocalAccountsForTests();
    expect(erasedLocalAccounts()).toEqual(['ok']);
    localStorage.setItem(STORAGE_KEY, '{corrupt');
    expect(erasedLocalAccounts()).toEqual([]);
  });

  it('reports an unpersisted mark but still blocks this session', async () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('quota', 'QuotaExceededError'); });
    expect((await eraseLocalAccount(ERASED)).markPersisted).toBe(false);
    expect(isLocalAccountErased(ERASED)).toBe(true);
  });
});
