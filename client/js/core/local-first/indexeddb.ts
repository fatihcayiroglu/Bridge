// P7 A1 — browser/PWA physical adapter for the encrypted local-first store.
//
// IndexedDB stores only encrypted record envelopes and non-extractable CryptoKey
// objects. It is NOT described as protection from same-origin XSS or an OS-level
// attacker. Native Capacitor will use a SQLite + platform secure-key adapter.

import { generateLocalFirstKey } from './crypto.ts';
import {
  EncryptedLocalStore,
  MemoryKeyProvider,
  MemoryRecordBackend,
  type EncryptedLocalRecord,
  type LocalFirstKeyProvider,
  type LocalFirstRecordBackend,
} from './store.ts';

const RECORD_DB = 'bridge-local-first-records-v1';
const RECORD_STORE = 'records';
const KEY_DB = 'bridge-local-first-keys-v1';
const KEY_STORE = 'keys';
const DB_VERSION = 1;

interface StoredKey {
  userId: string;
  v: 1;
  key: CryptoKey;
  createdAt: number;
}

function idb(): IDBFactory | null {
  try {
    return globalThis.indexedDB ?? null;
  } catch {
    return null;
  }
}

function openDb(name: string, storeName: string): Promise<IDBDatabase> {
  const factory = idb();
  if (!factory) return Promise.reject(new Error('IndexedDB is unavailable'));

  return new Promise((resolve, reject) => {
    const request = factory.open(name, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: storeName === KEY_STORE ? 'userId' : 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error(`Failed to open ${name}`));
    request.onblocked = () => reject(new Error(`${name} upgrade is blocked`));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
  });
}

function validStoredKey(value: unknown, userId: string): value is StoredKey {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<StoredKey>;
  const algorithm = row.key?.algorithm as { name?: unknown } | undefined;
  return Boolean(
    row.userId === userId
      && row.v === 1
      && row.key
      && row.key.type === 'secret'
      && row.key.extractable === false
      && algorithm?.name === 'AES-GCM'
      && row.key.usages.includes('encrypt')
      && row.key.usages.includes('decrypt'),
  );
}

export class IndexedDbKeyProvider implements LocalFirstKeyProvider {
  readonly kind = 'indexeddb-cryptokey';
  readonly durable = true;
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb(KEY_DB, KEY_STORE);
    return this.dbPromise;
  }

  async getOrCreate(userId: string): Promise<CryptoKey> {
    if (!userId) throw new Error('userId is required');

    const db = await this.db();
    const existingTx = db.transaction(KEY_STORE, 'readonly');
    const existing = await requestResult(existingTx.objectStore(KEY_STORE).get(userId));
    await transactionDone(existingTx);
    if (validStoredKey(existing, userId)) return existing.key;

    // Generate before the read/write transaction. Awaiting WebCrypto inside an
    // otherwise idle IDB transaction can let browsers auto-close it.
    const candidate = await generateLocalFirstKey();

    // Tabs may race. A read/write transaction is serialized; re-read inside it
    // and only the first writer persists its candidate.
    const tx = db.transaction(KEY_STORE, 'readwrite');
    const store = tx.objectStore(KEY_STORE);
    const winner = await requestResult(store.get(userId));
    if (validStoredKey(winner, userId)) {
      await transactionDone(tx);
      return winner.key;
    }

    store.put({ userId, v: 1, key: candidate, createdAt: Date.now() } satisfies StoredKey);
    await transactionDone(tx);
    return candidate;
  }

  async delete(userId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(KEY_STORE, 'readwrite');
    tx.objectStore(KEY_STORE).delete(userId);
    await transactionDone(tx);
  }

  close(): void {
    void this.dbPromise?.then(db => db.close()).catch(() => undefined);
    this.dbPromise = null;
  }
}

export class IndexedDbRecordBackend implements LocalFirstRecordBackend {
  readonly kind = 'indexeddb';
  readonly durable = true;
  private dbPromise: Promise<IDBDatabase> | null = null;

  private db(): Promise<IDBDatabase> {
    this.dbPromise ??= openDb(RECORD_DB, RECORD_STORE);
    return this.dbPromise;
  }

  async get(id: string): Promise<EncryptedLocalRecord | null> {
    const db = await this.db();
    const tx = db.transaction(RECORD_STORE, 'readonly');
    const result = await requestResult(tx.objectStore(RECORD_STORE).get(id));
    await transactionDone(tx);
    return (result as EncryptedLocalRecord | undefined) ?? null;
  }

  async put(record: EncryptedLocalRecord): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(RECORD_STORE, 'readwrite');
    tx.objectStore(RECORD_STORE).put(record);
    await transactionDone(tx);
  }

  async delete(id: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(RECORD_STORE, 'readwrite');
    tx.objectStore(RECORD_STORE).delete(id);
    await transactionDone(tx);
  }

  async listByPrefix(prefix: string): Promise<EncryptedLocalRecord[]> {
    const db = await this.db();
    const tx = db.transaction(RECORD_STORE, 'readonly');
    const store = tx.objectStore(RECORD_STORE);
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);
    const rows = await requestResult(store.getAll(range));
    await transactionDone(tx);
    return rows as EncryptedLocalRecord[];
  }

  async clearPrefix(prefix: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(RECORD_STORE, 'readwrite');
    const store = tx.objectStore(RECORD_STORE);
    const range = IDBKeyRange.bound(prefix, `${prefix}\uffff`);

    await new Promise<void>((resolve, reject) => {
      const request = store.openKeyCursor(range);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB cursor failed'));
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        store.delete(cursor.primaryKey);
        cursor.continue();
      };
    });
    await transactionDone(tx);
  }

  close(): void {
    void this.dbPromise?.then(db => db.close()).catch(() => undefined);
    this.dbPromise = null;
  }
}

export interface BrowserLocalFirstStore {
  store: EncryptedLocalStore;
  durable: boolean;
  backend: 'indexeddb' | 'memory';
  reason?: string;
}

/**
 * Browser composition root.
 *
 * If IndexedDB cannot even be opened, use an in-memory encrypted store and mark
 * it non-durable. Callers can keep the active session usable without claiming
 * that reload persistence exists.
 */
export async function createBrowserLocalFirstStore(userId: string): Promise<BrowserLocalFirstStore> {
  if (!idb()) {
    const store = new EncryptedLocalStore(userId, new MemoryRecordBackend(), new MemoryKeyProvider());
    return { store, durable: false, backend: 'memory', reason: 'IndexedDB unavailable' };
  }

  const records = new IndexedDbRecordBackend();
  const keys = new IndexedDbKeyProvider();
  try {
    // Force both databases open before reporting durability.
    await Promise.all([
      records.listByPrefix('__p7_capability_probe__'),
      keys.getOrCreate(userId),
    ]);
    const store = new EncryptedLocalStore(userId, records, keys);
    return { store, durable: true, backend: 'indexeddb' };
  } catch (cause) {
    records.close();
    keys.close();
    const store = new EncryptedLocalStore(userId, new MemoryRecordBackend(), new MemoryKeyProvider());
    return {
      store,
      durable: false,
      backend: 'memory',
      reason: cause instanceof Error ? cause.message : 'IndexedDB initialization failed',
    };
  }
}
