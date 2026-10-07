import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  IndexedDbKeyProvider,
  IndexedDbRecordBackend,
  createBrowserLocalFirstStore,
} from '../js/core/local-first/indexeddb.ts';
import type { EncryptedLocalRecord } from '../js/core/local-first/store.ts';

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
});
