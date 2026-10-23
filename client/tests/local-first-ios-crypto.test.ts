import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platform = vi.hoisted(() => ({ getPlatform: vi.fn(), isPluginAvailable: vi.fn() }));
const native = vi.hoisted(() => ({ hasKey: vi.fn(), ensureKey: vi.fn(), encrypt: vi.fn(), decrypt: vi.fn(), deleteKey: vi.fn() }));
vi.mock('@capacitor/core', () => ({ Capacitor: platform }));
vi.mock('@bridge/local-first-crypto', () => ({ BridgeLocalFirstCrypto: native }));

import { encryptLocalJson, decryptLocalJson } from '../js/core/local-first/crypto.ts';
import { iosLocalFirstCipher } from '../js/core/local-first/ios-crypto.ts';
import { createBrowserLocalFirstStore, IndexedDbKeyProvider, IndexedDbRecordBackend } from '../js/core/local-first/indexeddb.ts';
import { EncryptedLocalStore, LocalFirstCorruptionError, MemoryKeyProvider, MemoryRecordBackend, localRecordId } from '../js/core/local-first/store.ts';
import type { LocalFirstEnvelope } from '../js/core/local-first/crypto.ts';

describe('iOS local encryption bridge and composition (native API mocked; real WebCrypto envelope)', () => {
  let physical: MemoryRecordBackend;
  let keys: MemoryKeyProvider;
  let existing: Set<string>;
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('indexedDB', {});
    physical = new MemoryRecordBackend(); keys = new MemoryKeyProvider(); existing = new Set();
    platform.getPlatform.mockReturnValue('ios');
    platform.isPluginAvailable.mockReturnValue(true);
    vi.spyOn(IndexedDbRecordBackend.prototype, 'listByPrefix').mockImplementation(prefix => physical.listByPrefix(prefix));
    vi.spyOn(IndexedDbRecordBackend.prototype, 'put').mockImplementation(record => physical.put(record));
    vi.spyOn(IndexedDbRecordBackend.prototype, 'get').mockImplementation(id => physical.get(id));
    vi.spyOn(IndexedDbRecordBackend.prototype, 'clearPrefix').mockImplementation(prefix => physical.clearPrefix(prefix));
    vi.spyOn(IndexedDbKeyProvider.prototype, 'getOrCreate').mockRejectedValue(new DOMException('Unsupported key clone', 'DataCloneError'));
    vi.spyOn(IndexedDbKeyProvider.prototype, 'get').mockResolvedValue(null);
    native.hasKey.mockImplementation(async ({ userId }: { userId: string }) => ({ exists: existing.has(userId) }));
    native.ensureKey.mockImplementation(async ({ userId }: { userId: string }) => {
      await keys.getOrCreate(userId); existing.add(userId); return { persistent: true };
    });
    native.encrypt.mockImplementation(async ({ userId, plaintext, scope }: { userId: string; plaintext: string; scope: string }) => {
      if (!existing.has(userId)) throw new Error('Native key unavailable');
      const key = await keys.getOrCreate(userId);
      return encryptLocalJson(key, JSON.parse(plaintext), scope);
    });
    native.decrypt.mockImplementation(async ({ userId, envelope, scope }: { userId: string; envelope: LocalFirstEnvelope; scope: string }) => {
      if (!existing.has(userId)) throw new Error('Native key unavailable');
      return { plaintext: JSON.stringify(await decryptLocalJson(await keys.getOrCreate(userId), envelope, scope)) };
    });
    native.deleteKey.mockImplementation(async ({ userId }: { userId: string }) => { existing.delete(userId); await keys.delete(userId); });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it('creates a new account key in the native Keychain (fresh account)', async () => {
    const storage = await createBrowserLocalFirstStore('alice');
    expect(storage).toMatchObject({ durable: true, backend: 'indexeddb' });
    expect(storage.store.keyProviderKind).toBe('ios-keychain');
    await storage.store.putJson('draft', 'channel:c1', { text: 'private native fixture' });
    const raw = await physical.get(localRecordId('alice', 'draft', 'channel:c1'));
    expect(raw?.envelope).toMatchObject({ v: 1, alg: 'AES-GCM' });
    expect(JSON.stringify(raw)).not.toContain('private native fixture');
    await expect(storage.store.getJson('draft', 'channel:c1')).resolves.toEqual({ text: 'private native fixture' });
    expect(native.encrypt).toHaveBeenCalledWith({ userId: 'alice', plaintext: '{"text":"private native fixture"}', scope: 'user:alice:draft:channel%3Ac1' });
    expect(native.ensureKey).toHaveBeenCalledWith({ userId: 'alice' });
    expect(IndexedDbKeyProvider.prototype.getOrCreate).not.toHaveBeenCalled();
  });

  it('a WebView that CAN persist browser keys still gets a native key for a new account (no silent browser fallback)', async () => {
    // A signed app's WKWebView wraps and stores a non-extractable CryptoKey;
    // the provider must not depend on that (native D2L01-iOS, run 40025917599).
    const browserKey = vi.mocked(IndexedDbKeyProvider.prototype.getOrCreate).mockResolvedValue(await new MemoryKeyProvider().getOrCreate('alice'));
    const storage = await createBrowserLocalFirstStore('alice');
    expect(storage).toMatchObject({ durable: true, backend: 'indexeddb' });
    expect(storage.store.keyProviderKind).toBe('ios-keychain');
    expect(browserKey).not.toHaveBeenCalled();
    expect(IndexedDbKeyProvider.prototype.get).toHaveBeenCalledWith('alice');
    await storage.store.putJson('draft', 'channel:c1', { text: 'native only' });
    expect(native.encrypt).toHaveBeenCalledTimes(1);
    expect(existing.has('alice')).toBe(true);
  });

  it('reopens an existing native account key even when a newer OS supports browser keys', async () => {
    const first = await createBrowserLocalFirstStore('alice');
    await first.store.putJson('history', 'channel:c1', { messages: ['fixture'] }); first.store.close();
    const browser = vi.mocked(IndexedDbKeyProvider.prototype.getOrCreate).mockClear().mockResolvedValue(await new MemoryKeyProvider().getOrCreate('alice'));
    vi.mocked(IndexedDbKeyProvider.prototype.get).mockClear();
    const reopened = await createBrowserLocalFirstStore('alice');
    expect(browser).not.toHaveBeenCalled();
    expect(IndexedDbKeyProvider.prototype.get).not.toHaveBeenCalled();
    expect(reopened.store.keyProviderKind).toBe('ios-keychain');
    await expect(reopened.store.getJson('history', 'channel:c1')).resolves.toEqual({ messages: ['fixture'] });
  });

  it('preserves a working existing WebCrypto key instead of replacing legacy records', async () => {
    const legacyKeys = new MemoryKeyProvider();
    await new EncryptedLocalStore('alice', physical, legacyKeys).putJson('draft', 'c1', { text: 'existing legacy fixture' });
    const legacyKey = await legacyKeys.getOrCreate('alice');
    vi.mocked(IndexedDbKeyProvider.prototype.get).mockResolvedValue(legacyKey);
    vi.mocked(IndexedDbKeyProvider.prototype.getOrCreate).mockResolvedValue(legacyKey);
    const storage = await createBrowserLocalFirstStore('alice');
    expect(storage.store.keyProviderKind).toBe('indexeddb-cryptokey');
    await expect(storage.store.getJson('draft', 'c1')).resolves.toEqual({ text: 'existing legacy fixture' });
    expect(native.ensureKey).not.toHaveBeenCalled(); expect(native.encrypt).not.toHaveBeenCalled();
  });

  it('never reports durable native storage when key persistence cannot be proved', async () => {
    native.ensureKey.mockResolvedValue({ persistent: false });
    const storage = await createBrowserLocalFirstStore('alice');
    expect(storage).toMatchObject({ durable: false, backend: 'memory' });
    expect(IndexedDbRecordBackend.prototype.put).not.toHaveBeenCalled();
  });

  it('fails closed on unverifiable native key status without creating a browser replacement', async () => {
    native.hasKey.mockRejectedValue(new Error('Keychain unavailable'));
    const storage = await createBrowserLocalFirstStore('alice');
    expect(storage.durable).toBe(false);
    expect(IndexedDbKeyProvider.prototype.getOrCreate).not.toHaveBeenCalled();
    expect(IndexedDbKeyProvider.prototype.get).not.toHaveBeenCalled();
    expect(native.ensureKey).not.toHaveBeenCalled();
  });

  it('rejects malformed native status rather than treating an existing key as absent', async () => {
    native.hasKey.mockResolvedValue({ exists: 'unknown' });
    expect((await createBrowserLocalFirstStore('alice')).durable).toBe(false);
    expect(IndexedDbKeyProvider.prototype.getOrCreate).not.toHaveBeenCalled();
  });

  it.each([
    ['QuotaExceededError'], ['DataCloneError'], ['UnknownError'],
  ])('an unverifiable browser-key lookup (%s) fails closed: no native key is created over possible legacy records', async name => {
    vi.mocked(IndexedDbKeyProvider.prototype.get).mockRejectedValue(new DOMException('lookup failed', name));
    const storage = await createBrowserLocalFirstStore('alice');
    expect(storage).toMatchObject({ durable: false, backend: 'memory' });
    expect(native.ensureKey).not.toHaveBeenCalled();
    expect(IndexedDbKeyProvider.prototype.getOrCreate).not.toHaveBeenCalled();
  });

  it.each(['web', 'android'])('keeps %s on the existing storage composition', async name => {
    platform.getPlatform.mockReturnValue(name);
    expect(iosLocalFirstCipher('alice')).toBeNull();
    vi.mocked(IndexedDbKeyProvider.prototype.getOrCreate).mockResolvedValue(await keys.getOrCreate('alice'));
    const storage = await createBrowserLocalFirstStore('alice');
    expect(storage.store.keyProviderKind).toBe('indexeddb-cryptokey');
    expect(native.hasKey).not.toHaveBeenCalled();
  });

  it('does not claim native persistence when the binary lacks the plugin', async () => {
    platform.isPluginAvailable.mockReturnValue(false);
    expect(iosLocalFirstCipher('alice')).toBeNull();
    expect((await createBrowserLocalFirstStore('alice')).durable).toBe(false);
  });

  it('refuses cross-account cipher injection and scopes before any native call', async () => {
    const cipher = iosLocalFirstCipher('alice')!;
    expect(() => new EncryptedLocalStore('bob', physical, null, cipher)).toThrow('account-bound');
    expect(() => new EncryptedLocalStore('alice', physical, null)).toThrow('Exactly one');
    expect(() => new EncryptedLocalStore('alice', physical, keys, cipher)).toThrow('Exactly one');
    await expect(cipher.encryptJson({}, 'user:bob:draft:c1')).rejects.toThrow('scope mismatch');
    await expect(cipher.decryptJson({ v: 1, alg: 'AES-GCM', iv: '', ct: '' }, 'user:bob:draft:c1')).rejects.toThrow('scope mismatch');
    expect(native.encrypt).not.toHaveBeenCalled(); expect(native.decrypt).not.toHaveBeenCalled();
  });

  it('erases only the account records and native key, and a late read cannot recreate it', async () => {
    const alice = (await createBrowserLocalFirstStore('alice')).store;
    const bob = (await createBrowserLocalFirstStore('bob')).store;
    await alice.putJson('draft', 'c1', { text: 'alice fixture' }); await bob.putJson('draft', 'c1', { text: 'bob fixture' });
    const stale = (await physical.get(localRecordId('alice', 'draft', 'c1')))!;
    await alice.wipeAccount();
    expect(native.deleteKey).toHaveBeenCalledWith({ userId: 'alice' });
    expect(await physical.listByPrefix('u:alice|')).toEqual([]);
    await expect(bob.getJson('draft', 'c1')).resolves.toEqual({ text: 'bob fixture' });
    await physical.put(stale);
    await expect(alice.getJson('draft', 'c1')).rejects.toBeInstanceOf(LocalFirstCorruptionError);
    expect(existing.has('alice')).toBe(false);
    await expect(alice.putJson('draft', 'late', { text: 'late fixture' })).rejects.toThrow('Native key unavailable');
    expect(existing.has('alice')).toBe(false);
  });

  it('preserves the key when record removal fails', async () => {
    const storage = await createBrowserLocalFirstStore('alice');
    vi.mocked(IndexedDbRecordBackend.prototype.clearPrefix).mockRejectedValue(new Error('Deletion unavailable'));
    await expect(storage.store.wipeAccount()).rejects.toThrow('Deletion unavailable');
    expect(native.deleteKey).not.toHaveBeenCalled(); expect(existing.has('alice')).toBe(true);
  });

  it('does not persist unverified encryption output or hide native encryption failures', async () => {
    const storage = await createBrowserLocalFirstStore('alice');
    native.encrypt.mockRejectedValueOnce(new Error('Native unavailable'));
    await expect(storage.store.putJson('draft', 'c1', {})).rejects.toThrow('Native unavailable');
    native.encrypt.mockResolvedValueOnce({ v: 2 });
    await expect(storage.store.putJson('draft', 'c1', {})).rejects.toThrow('Invalid native encryption envelope');
    await expect(iosLocalFirstCipher('alice')!.encryptJson(undefined, 'user:alice:draft:c1')).rejects.toThrow('Invalid local JSON');
    expect(IndexedDbRecordBackend.prototype.put).not.toHaveBeenCalled();
  });

  it('lists authenticated native records and rejects malformed decrypted values', async () => {
    const storage = await createBrowserLocalFirstStore('alice');
    await storage.store.putJson('draft', 'c1', { text: 'fixture' }, 1);
    await expect(storage.store.list('draft')).resolves.toEqual([{ recordId: 'c1', updatedAt: 1, value: { text: 'fixture' } }]);
    native.decrypt.mockResolvedValueOnce({ plaintext: 7 });
    await expect(storage.store.getJson('draft', 'c1')).rejects.toBeInstanceOf(LocalFirstCorruptionError);
    native.decrypt.mockResolvedValueOnce({ plaintext: 'not JSON' });
    await expect(storage.store.getJson('draft', 'c1')).rejects.toBeInstanceOf(LocalFirstCorruptionError);
  });
});
