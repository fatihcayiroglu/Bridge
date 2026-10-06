// P7 A1 — encrypted local-first logical store.
//
// The physical backend is deliberately replaceable. Browser/PWA currently uses
// IndexedDB; native SQLite will implement the same RecordBackend contract.
// Sensitive values cross this boundary only as AES-GCM envelopes.

import {
  decryptLocalJson,
  encryptLocalJson,
  generateLocalFirstKey,
  type LocalFirstEnvelope,
} from './crypto.ts';

export const LOCAL_FIRST_RECORD_VERSION = 1;

export type LocalFirstNamespace =
  | 'draft'
  | 'outbox'
  | 'history'
  | 'oplog'
  | 'search-meta';

export interface EncryptedLocalRecord {
  id: string;
  userId: string;
  namespace: LocalFirstNamespace;
  recordId: string;
  v: typeof LOCAL_FIRST_RECORD_VERSION;
  envelope: LocalFirstEnvelope;
  updatedAt: number;
}

export interface LocalFirstRecordBackend {
  readonly kind: string;
  readonly durable: boolean;
  get(id: string): Promise<EncryptedLocalRecord | null>;
  put(record: EncryptedLocalRecord): Promise<void>;
  delete(id: string): Promise<void>;
  listByPrefix(prefix: string): Promise<EncryptedLocalRecord[]>;
  clearPrefix(prefix: string): Promise<void>;
  close?(): void;
}

export interface LocalFirstKeyProvider {
  readonly kind: string;
  readonly durable: boolean;
  getOrCreate(userId: string): Promise<CryptoKey>;
  delete(userId: string): Promise<void>;
  close?(): void;
}

export class LocalFirstCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LocalFirstCorruptionError';
  }
}

function segment(value: string, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is required`);
  if (value.length > 512) throw new Error(`${label} is too large`);
  return encodeURIComponent(value);
}

export function localRecordId(
  userId: string,
  namespace: LocalFirstNamespace,
  recordId: string,
): string {
  return `u:${segment(userId, 'userId')}|n:${namespace}|r:${segment(recordId, 'recordId')}`;
}

export function localUserPrefix(userId: string): string {
  return `u:${segment(userId, 'userId')}|`;
}

export function localNamespacePrefix(userId: string, namespace: LocalFirstNamespace): string {
  return `${localUserPrefix(userId)}n:${namespace}|`;
}

export function localRecordScope(
  userId: string,
  namespace: LocalFirstNamespace,
  recordId: string,
): string {
  return `user:${segment(userId, 'userId')}:${namespace}:${segment(recordId, 'recordId')}`;
}

function validRecord(
  value: EncryptedLocalRecord | null,
  userId: string,
  namespace: LocalFirstNamespace,
  recordId: string,
): value is EncryptedLocalRecord {
  return Boolean(
    value
      && value.v === LOCAL_FIRST_RECORD_VERSION
      && value.userId === userId
      && value.namespace === namespace
      && value.recordId === recordId
      && value.id === localRecordId(userId, namespace, recordId)
      && Number.isFinite(value.updatedAt),
  );
}

export class EncryptedLocalStore {
  readonly durable: boolean;

  constructor(
    readonly userId: string,
    private readonly backend: LocalFirstRecordBackend,
    private readonly keys: LocalFirstKeyProvider,
  ) {
    segment(userId, 'userId');
    this.durable = backend.durable && keys.durable;
  }

  get backendKind(): string {
    return this.backend.kind;
  }

  get keyProviderKind(): string {
    return this.keys.kind;
  }

  async putJson<T>(
    namespace: LocalFirstNamespace,
    recordId: string,
    value: T,
    updatedAt = Date.now(),
  ): Promise<void> {
    if (!Number.isFinite(updatedAt) || updatedAt < 0) throw new Error('updatedAt is invalid');
    const key = await this.keys.getOrCreate(this.userId);
    const envelope = await encryptLocalJson(
      key,
      value,
      localRecordScope(this.userId, namespace, recordId),
    );
    await this.backend.put({
      id: localRecordId(this.userId, namespace, recordId),
      userId: this.userId,
      namespace,
      recordId,
      v: LOCAL_FIRST_RECORD_VERSION,
      envelope,
      updatedAt,
    });
  }

  async getJson<T>(namespace: LocalFirstNamespace, recordId: string): Promise<T | null> {
    const id = localRecordId(this.userId, namespace, recordId);
    const record = await this.backend.get(id);
    if (!record) return null;
    if (!validRecord(record, this.userId, namespace, recordId)) {
      throw new LocalFirstCorruptionError('Local-first record metadata is invalid');
    }

    try {
      const key = await this.keys.getOrCreate(this.userId);
      return await decryptLocalJson<T>(
        key,
        record.envelope,
        localRecordScope(this.userId, namespace, recordId),
      );
    } catch (cause) {
      throw new LocalFirstCorruptionError('Local-first record authentication failed', { cause });
    }
  }

  async delete(namespace: LocalFirstNamespace, recordId: string): Promise<void> {
    await this.backend.delete(localRecordId(this.userId, namespace, recordId));
  }

  async list<T>(
    namespace: LocalFirstNamespace,
  ): Promise<Array<{ recordId: string; value: T; updatedAt: number }>> {
    const rows = await this.backend.listByPrefix(localNamespacePrefix(this.userId, namespace));
    const result: Array<{ recordId: string; value: T; updatedAt: number }> = [];

    for (const row of rows) {
      if (
        row.userId !== this.userId
        || row.namespace !== namespace
        || row.v !== LOCAL_FIRST_RECORD_VERSION
        || row.id !== localRecordId(this.userId, namespace, row.recordId)
      ) {
        throw new LocalFirstCorruptionError('Local-first namespace contains an invalid record');
      }
      try {
        const key = await this.keys.getOrCreate(this.userId);
        result.push({
          recordId: row.recordId,
          value: await decryptLocalJson<T>(
            key,
            row.envelope,
            localRecordScope(this.userId, namespace, row.recordId),
          ),
          updatedAt: row.updatedAt,
        });
      } catch (cause) {
        throw new LocalFirstCorruptionError('Local-first namespace authentication failed', { cause });
      }
    }

    return result.sort((a, b) => a.updatedAt - b.updatedAt);
  }

  async clearNamespace(namespace: LocalFirstNamespace): Promise<void> {
    await this.backend.clearPrefix(localNamespacePrefix(this.userId, namespace));
  }

  /**
   * Account wipe is destructive by design. Records are deleted before the key:
   * a partial failure still leaves data decryptable for recovery instead of
   * orphaning encrypted records permanently.
   */
  async wipeAccount(): Promise<void> {
    await this.backend.clearPrefix(localUserPrefix(this.userId));
    await this.keys.delete(this.userId);
  }

  close(): void {
    this.backend.close?.();
    this.keys.close?.();
  }
}

export class MemoryRecordBackend implements LocalFirstRecordBackend {
  readonly kind = 'memory';
  readonly durable = false;
  private readonly records = new Map<string, EncryptedLocalRecord>();

  async get(id: string): Promise<EncryptedLocalRecord | null> {
    return this.records.get(id) ?? null;
  }

  async put(record: EncryptedLocalRecord): Promise<void> {
    this.records.set(record.id, structuredClone(record));
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async listByPrefix(prefix: string): Promise<EncryptedLocalRecord[]> {
    return [...this.records.entries()]
      .filter(([id]) => id.startsWith(prefix))
      .map(([, value]) => structuredClone(value));
  }

  async clearPrefix(prefix: string): Promise<void> {
    for (const id of this.records.keys()) {
      if (id.startsWith(prefix)) this.records.delete(id);
    }
  }

  /** Test-only corruption hook; never used by production composition. */
  corrupt(id: string, record: EncryptedLocalRecord): void {
    this.records.set(id, record);
  }
}

export class MemoryKeyProvider implements LocalFirstKeyProvider {
  readonly kind = 'memory';
  readonly durable = false;
  private readonly keys = new Map<string, CryptoKey>();

  async getOrCreate(userId: string): Promise<CryptoKey> {
    const existing = this.keys.get(userId);
    if (existing) return existing;
    const key = await generateLocalFirstKey();
    this.keys.set(userId, key);
    return key;
  }

  async delete(userId: string): Promise<void> {
    this.keys.delete(userId);
  }
}
