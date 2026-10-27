import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  IndexedDbKeyProvider,
  IndexedDbRecordBackend,
  createBrowserLocalFirstStore,
  openExistingBrowserLocalFirstStore,
} from '../js/core/local-first/indexeddb.ts';
import {
  OFFLINE_SESSION_MAX_AGE_MS,
  clearOfflineSession,
  recordOfflineSession,
  tokenAccountId,
  unlockOfflineSession,
} from '../js/core/local-first/offline-session.ts';
import { markLocalAccountErased, resetErasedLocalAccountsForTests } from '../js/core/local-first/erased-accounts.ts';
import type { EncryptedLocalRecord } from '../js/core/local-first/store.ts';
import { EncryptedLocalStore } from '../js/core/local-first/store.ts';

type Handler<T> = ((this: T, event: Event) => unknown) | null;

interface RequestStub<T> {
  result: T;
  error: DOMException | null;
  onsuccess: Handler<RequestStub<T>>;
  onerror: Handler<RequestStub<T>>;
}

function makeRequest<T>(initial: T): RequestStub<T> {
  return { result: initial, error: null, onsuccess: null, onerror: null };
}

function success<T>(request: RequestStub<T>, value: T): void {
  request.result = value;
  queueMicrotask(() => request.onsuccess?.call(request, new Event('success')));
}

interface RangeStub {
  lower: string;
  upper: string;
}

class FakeStoreData {
  constructor(
    readonly keyPath: 'id' | 'userId',
    readonly rows = new Map<string, unknown>(),
  ) {}
}

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: Handler<FakeTransaction> = null;
  onabort: Handler<FakeTransaction> = null;
  onerror: Handler<FakeTransaction> = null;

  constructor(private readonly data: FakeStoreData) {
    setTimeout(() => this.oncomplete?.call(this, new Event('complete')), 0);
  }

  objectStore(): IDBObjectStore {
    const data = this.data;
    const store = {
      get(key: IDBValidKey) {
        const request = makeRequest<unknown>(undefined);
        success(request, data.rows.get(String(key)));
        return request as unknown as IDBRequest<unknown>;
      },
      put(value: unknown) {
        const row = value as Record<string, unknown>;
        const key = String(row[data.keyPath] ?? '');
        data.rows.set(key, value);
        const request = makeRequest<IDBValidKey>(key);
        success(request, key);
        return request as unknown as IDBRequest<IDBValidKey>;
      },
      delete(key: IDBValidKey) {
        data.rows.delete(String(key));
        const request = makeRequest<undefined>(undefined);
        success(request, undefined);
        return request as unknown as IDBRequest<undefined>;
      },
      getAll(range?: IDBKeyRange) {
        const bounds = range as unknown as RangeStub | undefined;
        const values = [...data.rows.entries()]
          .filter(([key]) => !bounds || (key >= bounds.lower && key <= bounds.upper))
          .map(([, value]) => value);
        const request = makeRequest<unknown[]>([]);
        success(request, values);
        return request as unknown as IDBRequest<unknown[]>;
      },
      openKeyCursor(range?: IDBKeyRange) {
        const bounds = range as unknown as RangeStub | undefined;
        const keys = [...data.rows.keys()]
          .filter(key => !bounds || (key >= bounds.lower && key <= bounds.upper))
          .sort();
        const request = makeRequest<IDBCursor | null>(null);
        let index = 0;
        const emit = (): void => {
          if (index >= keys.length) {
            success(request, null);
            return;
          }
          const key = keys[index]!;
          const cursor = {
            primaryKey: key,
            continue() {
              index += 1;
              queueMicrotask(emit);
            },
          } as unknown as IDBCursor;
          success(request, cursor);
        };
        queueMicrotask(emit);
        return request as unknown as IDBRequest<IDBCursor | null>;
      },
    };
    return store as unknown as IDBObjectStore;
  }
}

class FakeDatabase {
  readonly stores = new Map<string, FakeStoreData>();
  closed = false;

  readonly objectStoreNames = {
    contains: (name: string) => this.stores.has(name),
  } as unknown as DOMStringList;

  createObjectStore(name: string, options?: IDBObjectStoreParameters): IDBObjectStore {
    const keyPath = options?.keyPath === 'userId' ? 'userId' : 'id';
    const data = new FakeStoreData(keyPath);
    this.stores.set(name, data);
    return new FakeTransaction(data).objectStore();
  }

  transaction(name: string): IDBTransaction {
    const data = this.stores.get(name);
    if (!data) throw new Error(`missing store: ${name}`);
    return new FakeTransaction(data) as unknown as IDBTransaction;
  }

  close(): void {
    this.closed = true;
  }
}

class FakeFactory {
  readonly dbs = new Map<string, FakeDatabase>();
  mode: 'ok' | 'error' | 'blocked' = 'ok';

  open(name: string): IDBOpenDBRequest {
    const request = {
      result: undefined as unknown as IDBDatabase,
      error: null as DOMException | null,
      onsuccess: null as Handler<IDBOpenDBRequest>,
      onerror: null as Handler<IDBOpenDBRequest>,
      onblocked: null as Handler<IDBOpenDBRequest>,
      onupgradeneeded: null as Handler<IDBOpenDBRequest>,
    };

    queueMicrotask(() => {
      if (this.mode === 'error') {
        request.error = new DOMException('open failed', 'UnknownError');
        request.onerror?.call(request as unknown as IDBOpenDBRequest, new Event('error'));
        return;
      }
      if (this.mode === 'blocked') {
        request.onblocked?.call(request as unknown as IDBOpenDBRequest, new Event('blocked'));
        return;
      }

      let db = this.dbs.get(name);
      const created = !db;
      if (!db) {
        db = new FakeDatabase();
        this.dbs.set(name, db);
      }
      request.result = db as unknown as IDBDatabase;
      if (created) request.onupgradeneeded?.call(request as unknown as IDBOpenDBRequest, new Event('upgradeneeded'));
      request.onsuccess?.call(request as unknown as IDBOpenDBRequest, new Event('success'));
    });

    return request as unknown as IDBOpenDBRequest;
  }
}

const indexedDbDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB');
const keyRangeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'IDBKeyRange');
let factory: FakeFactory;

function installFactory(value: IDBFactory | null): void {
  Object.defineProperty(globalThis, 'indexedDB', {
    configurable: true,
    value,
  });
  Object.defineProperty(globalThis, 'IDBKeyRange', {
    configurable: true,
    value: {
      bound(lower: IDBValidKey, upper: IDBValidKey) {
        return { lower: String(lower), upper: String(upper) } as unknown as IDBKeyRange;
      },
    },
  });
}

function restoreGlobal(name: 'indexedDB' | 'IDBKeyRange', descriptor: PropertyDescriptor | undefined): void {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}

function record(id: string, userId = 'u1'): EncryptedLocalRecord {
  return {
    id,
    userId,
    namespace: 'history',
    recordId: id,
    v: 1,
    envelope: { v: 1, alg: 'AES-GCM', iv: 'AAAAAAAAAAAAAAAA', ct: 'AAAAAAAAAAAAAAAAAAAAAA==' },
    updatedAt: 1,
  };
}

beforeEach(() => {
  factory = new FakeFactory();
  installFactory(factory as unknown as IDBFactory);
});

afterEach(() => {
  restoreGlobal('indexedDB', indexedDbDescriptor);
  restoreGlobal('IDBKeyRange', keyRangeDescriptor);
});

describe('P7 IndexedDB local-first adapter', () => {
  it('persists, lists, clears and deletes encrypted physical records', async () => {
    const backend = new IndexedDbRecordBackend();
    const a = record('u:u1|n:history|r:a');
    const b = record('u:u1|n:history|r:b');
    const other = record('u:u2|n:history|r:c', 'u2');

    await backend.put(a);
    await backend.put(b);
    await backend.put(other);

    await expect(backend.get(a.id)).resolves.toEqual(a);
    await expect(backend.get('missing')).resolves.toBeNull();
    await expect(backend.listByPrefix('u:u1|n:history|')).resolves.toEqual([a, b]);

    await backend.delete(a.id);
    await expect(backend.get(a.id)).resolves.toBeNull();

    await backend.clearPrefix('u:u1|');
    await expect(backend.listByPrefix('u:u1|')).resolves.toEqual([]);
    await expect(backend.get(other.id)).resolves.toEqual(other);

    backend.close();
    await Promise.resolve();
  });

  it('persists and reuses non-extractable AES keys, including a second provider instance', async () => {
    const first = new IndexedDbKeyProvider();
    const key1 = await first.getOrCreate('u1');
    expect(key1.extractable).toBe(false);
    expect(key1.algorithm.name).toBe('AES-GCM');

    expect(await first.getOrCreate('u1')).toBe(key1);

    const second = new IndexedDbKeyProvider();
    expect(await second.getOrCreate('u1')).toBe(key1);

    await second.delete('u1');
    const key2 = await second.getOrCreate('u1');
    expect(key2).not.toBe(key1);

    first.close();
    second.close();
    await Promise.resolve();
  });

  it('two tabs creating the account key at the same time converge on ONE key', async () => {
    const tabA = new IndexedDbKeyProvider();
    const tabB = new IndexedDbKeyProvider();
    const [a, b] = await Promise.all([tabA.getOrCreate('race-user'), tabB.getOrCreate('race-user')]);
    expect(a).toBe(b);
    expect(await new IndexedDbKeyProvider().getOrCreate('race-user')).toBe(a);
    tabA.close();
    tabB.close();
    await Promise.resolve();
  });

  it('composition root reports durable IndexedDB and performs an encrypted JSON round trip', async () => {
    const runtime = await createBrowserLocalFirstStore('browser-user');
    expect(runtime).toMatchObject({ durable: true, backend: 'indexeddb' });

    await runtime.store.putJson('search-meta', 'probe', { text: 'private value' }, 10);
    await expect(runtime.store.getJson('search-meta', 'probe')).resolves.toEqual({ text: 'private value' });
    runtime.store.close();
  });

  it('falls back honestly when IndexedDB is absent or inaccessible', async () => {
    installFactory(null);
    await expect(createBrowserLocalFirstStore('no-idb')).resolves.toMatchObject({
      durable: false,
      backend: 'memory',
      reason: 'IndexedDB unavailable',
    });

    Object.defineProperty(globalThis, 'indexedDB', {
      configurable: true,
      get() { throw new Error('privacy mode'); },
    });
    await expect(createBrowserLocalFirstStore('blocked-getter')).resolves.toMatchObject({
      durable: false,
      backend: 'memory',
      reason: 'IndexedDB unavailable',
    });
  });

  it('falls back if database open fails or is blocked, preserving the failure reason', async () => {
    factory.mode = 'error';
    await expect(createBrowserLocalFirstStore('open-error')).resolves.toMatchObject({
      durable: false,
      backend: 'memory',
      reason: 'open failed',
    });

    factory = new FakeFactory();
    factory.mode = 'blocked';
    installFactory(factory as unknown as IDBFactory);
    await expect(createBrowserLocalFirstStore('open-blocked')).resolves.toMatchObject({
      durable: false,
      backend: 'memory',
      reason: expect.stringContaining('upgrade is blocked'),
    });
  });

  it('uses a generic fallback reason when the IDB factory throws a non-Error value', async () => {
    installFactory({
      open() { throw 'opaque idb failure'; },
    } as unknown as IDBFactory);

    await expect(createBrowserLocalFirstStore('opaque-failure')).resolves.toMatchObject({
      durable: false,
      backend: 'memory',
      reason: 'IndexedDB initialization failed',
    });
  });

  it('rejects an empty key-provider identity', async () => {
    const provider = new IndexedDbKeyProvider();
    await expect(provider.getOrCreate('')).rejects.toThrow('userId is required');
  });

  it('ignores malformed persisted key rows and replaces them with a valid AES key', async () => {
    const provider = new IndexedDbKeyProvider();
    const first = await provider.getOrCreate('u1');

    const keyDb = factory.dbs.get('bridge-local-first-keys-v1')!;
    const keys = keyDb.stores.get('keys')!;
    keys.rows.set('u2', { userId: 'u2', v: 1, key: { type: 'public' } });
    keys.rows.set('u3', { userId: 'wrong', v: 1, key: first });

    const second = await provider.getOrCreate('u2');
    const third = await provider.getOrCreate('u3');
    expect(second.type).toBe('secret');
    expect(third.type).toBe('secret');
    expect(second).not.toBe(first);
    expect(third).not.toBe(first);
  });

  it('surfaces request failures from the physical backend', async () => {
    const backend = new IndexedDbRecordBackend();
    await backend.put(record('u:u1|n:history|r:a'));

    const db = factory.dbs.get('bridge-local-first-records-v1')!;
    db.transaction = (() => {
      const request = makeRequest<unknown>(undefined);
      queueMicrotask(() => {
        request.error = new DOMException('request failed', 'UnknownError');
        request.onerror?.call(request, new Event('error'));
      });

      return {
        error: null,
        oncomplete: null,
        onabort: null,
        onerror: null,
        objectStore: () => ({
          get: () => request as unknown as IDBRequest<unknown>,
        }),
      } as unknown as IDBTransaction;
    }) as typeof db.transaction;

    await expect(backend.get('x')).rejects.toThrow('request failed');
  });
});

/** A JWT-shaped token naming `id`; offline unlock never verifies its signature. */
function token(id: string, nonce = 'a'): string {
  const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'HS256' })}.${b64({ id, n: nonce })}.signature`;
}

describe('P7 offline reload: device-bound offline grant (owner decision on #497)', () => {
  const NOW = 1_800_000_000_000;
  const user = { _id: 'offline-u1', username: 'alice', displayName: 'Alice', email: 'never-stored@example.test' };

  it('does not resurrect a grant when a server-validated write finishes after logout clears it', async () => {
    const t = token(user._id);
    await recordOfflineSession(user, t, NOW);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = EncryptedLocalStore.prototype.putJson;
    const write = vi.spyOn(EncryptedLocalStore.prototype, 'putJson').mockImplementationOnce(async function (this: EncryptedLocalStore, ...args) {
      await gate;
      return original.apply(this, args);
    });
    try {
      const pending = recordOfflineSession(user, t, NOW + 1);
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
      await clearOfflineSession(user._id);
      expect(await unlockOfflineSession(t, NOW + 2)).toEqual({ ok: false, reason: 'no-grant' });
      release();
      await pending;
      expect(await unlockOfflineSession(t, NOW + 3)).toEqual({ ok: false, reason: 'no-grant' });
    } finally {
      release();
      write.mockRestore();
    }
  });

  it('keeps the newest refreshed token grant when an older encrypted write finishes later', async () => {
    const oldToken = token(user._id, 'old');
    const newToken = token(user._id, 'new');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = EncryptedLocalStore.prototype.putJson;
    const write = vi.spyOn(EncryptedLocalStore.prototype, 'putJson').mockImplementationOnce(async function (this: EncryptedLocalStore, ...args) {
      await gate;
      return original.apply(this, args);
    });
    try {
      const pending = recordOfflineSession(user, oldToken, NOW);
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
      await recordOfflineSession(user, newToken, NOW + 1);
      release(); await pending;
      expect((await unlockOfflineSession(newToken, NOW + 2)).ok).toBe(true);
      expect(await unlockOfflineSession(oldToken, NOW + 2)).toEqual({ ok: false, reason: 'token-mismatch' });
    } finally { release(); write.mockRestore(); }
  });

  it('does not let a delayed clear delete a newer validated grant', async () => {
    const t = token(user._id);
    await recordOfflineSession(user, t, NOW);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = EncryptedLocalStore.prototype.delete;
    const deletion = vi.spyOn(EncryptedLocalStore.prototype, 'delete').mockImplementationOnce(async function (this: EncryptedLocalStore, ...args) {
      await gate;
      return original.apply(this, args);
    });
    try {
      const clearing = clearOfflineSession(user._id);
      await vi.waitFor(() => expect(deletion).toHaveBeenCalledOnce());
      await recordOfflineSession(user, t, NOW + 1);
      release(); await clearing;
      expect(await unlockOfflineSession(t, NOW + 2)).toEqual({
        ok: true, validatedAt: NOW + 1, user: { _id: user._id, username: 'alice', displayName: 'Alice' },
      });
    } finally { release(); deletion.mockRestore(); }
  });

  it('rechecks mutation guards after opening IndexedDB before starting a transaction', async () => {
    const backend = new IndexedDbRecordBackend();
    const row = record('guarded-record');
    let current = true;
    const pending = backend.put(row, () => current);
    current = false;
    await pending;
    expect(await backend.get(row.id)).toBeNull();
    await backend.put(row);
    current = true;
    const clearing = backend.delete(row.id, () => current);
    current = false;
    await clearing;
    expect(await backend.get(row.id)).toEqual(row);
    backend.close();
  });

  it('drops a guarded encrypted write invalidated during asynchronous encryption', async () => {
    const { store } = await createBrowserLocalFirstStore(user._id);
    let current = true;
    const pending = store.putJson('session', 'guarded-encryption', { proof: 'private' }, NOW, () => current);
    current = false;
    await pending;
    expect(await store.getJson('session', 'guarded-encryption')).toBeNull();
    store.close();
  });

  it('does not let an already invalid session supersede a pending clear', async () => {
    const t = token(user._id);
    await recordOfflineSession(user, t, NOW);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = EncryptedLocalStore.prototype.delete;
    const deletion = vi.spyOn(EncryptedLocalStore.prototype, 'delete').mockImplementationOnce(async function (this: EncryptedLocalStore, ...args) {
      await gate;
      return original.apply(this, args);
    });
    try {
      const clearing = clearOfflineSession(user._id);
      await vi.waitFor(() => expect(deletion).toHaveBeenCalledOnce());
      await recordOfflineSession(user, t, NOW + 1, () => false);
      release(); await clearing;
      expect(await unlockOfflineSession(t, NOW + 2)).toEqual({ ok: false, reason: 'no-grant' });
    } finally { release(); deletion.mockRestore(); }
  });

  it('keeps grant mutation ordering scoped to the account', async () => {
    const t = token(user._id);
    const other = { _id: 'offline-other' };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = EncryptedLocalStore.prototype.putJson;
    const write = vi.spyOn(EncryptedLocalStore.prototype, 'putJson').mockImplementationOnce(async function (this: EncryptedLocalStore, ...args) {
      await gate;
      return original.apply(this, args);
    });
    try {
      const pending = recordOfflineSession(user, t, NOW);
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
      await recordOfflineSession(other, token(other._id), NOW);
      await clearOfflineSession(other._id);
      release(); await pending;
      expect((await unlockOfflineSession(t, NOW + 1)).ok).toBe(true);
      expect(await unlockOfflineSession(token(other._id), NOW + 1)).toEqual({ ok: false, reason: 'no-grant' });
    } finally { release(); write.mockRestore(); }
  });

  it('opens an existing store only when this device already holds the account key, and never creates one', async () => {
    expect(await openExistingBrowserLocalFirstStore('fresh-user')).toBeNull();
    expect(await new IndexedDbKeyProvider().get('fresh-user')).toBeNull();
    const runtime = await createBrowserLocalFirstStore('fresh-user');
    runtime.store.close();
    const store = await openExistingBrowserLocalFirstStore('fresh-user');
    expect(store).not.toBeNull();
    store?.close();
  });

  it('a recorded grant unlocks the same account for the same token, with only allowlisted profile fields', async () => {
    const t = token(user._id);
    expect(tokenAccountId(t)).toBe(user._id);
    await recordOfflineSession(user, t, NOW);
    const result = await unlockOfflineSession(t, NOW + 1_000);
    expect(result).toEqual({ ok: true, validatedAt: NOW, user: { _id: user._id, username: 'alice', displayName: 'Alice' } });
  });

  it('fails closed: no token, no account in it, no device key, other token, expiry, clock, logout, erasure, corruption', async () => {
    const t = token(user._id);
    await recordOfflineSession(user, t, NOW);

    expect(await unlockOfflineSession(null, NOW)).toEqual({ ok: false, reason: 'no-token' });
    expect(await unlockOfflineSession('not-a-jwt', NOW)).toEqual({ ok: false, reason: 'no-account' });
    // Another account: this device never held its key, and none is created.
    expect(await unlockOfflineSession(token('someone-else'), NOW)).toEqual({ ok: false, reason: 'no-device-key' });
    expect(await new IndexedDbKeyProvider().get('someone-else')).toBeNull();
    // The same account with a token the server never validated on this device.
    expect(await unlockOfflineSession(token(user._id, 'forged'), NOW)).toEqual({ ok: false, reason: 'token-mismatch' });
    expect(await unlockOfflineSession(t, NOW + OFFLINE_SESSION_MAX_AGE_MS)).toEqual({ ok: false, reason: 'expired' });
    expect(await unlockOfflineSession(t, NOW - 10 * 60_000)).toEqual({ ok: false, reason: 'clock' });

    // A grant for a token naming another account is never written.
    await recordOfflineSession({ _id: 'mismatch-user' }, token('different-user'), NOW);
    expect(await openExistingBrowserLocalFirstStore('mismatch-user')).toBeNull();

    // Tampered ciphertext: authentication fails, nothing is returned.
    const db = factory.dbs.get('bridge-local-first-records-v1')!;
    const rows = (db as unknown as { stores: Map<string, { rows: Map<string, EncryptedLocalRecord> }> }).stores.get('records')!.rows;
    const grantId = [...rows.keys()].find(k => k.includes('n:session'))!;
    const original = rows.get(grantId)!;
    rows.set(grantId, { ...original, envelope: { ...original.envelope, ct: original.envelope.ct.replace(/^./, c => (c === 'A' ? 'B' : 'A')) } });
    expect(await unlockOfflineSession(t, NOW)).toEqual({ ok: false, reason: 'corrupt' });
    rows.set(grantId, original);
    expect((await unlockOfflineSession(t, NOW)).ok).toBe(true);

    await clearOfflineSession(user._id);
    expect(await unlockOfflineSession(t, NOW)).toEqual({ ok: false, reason: 'no-grant' });

    await recordOfflineSession(user, t, NOW);
    markLocalAccountErased(user._id);
    expect(await unlockOfflineSession(t, NOW)).toEqual({ ok: false, reason: 'erased' });
    resetErasedLocalAccountsForTests();
  });
});
