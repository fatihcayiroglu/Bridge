// P7 A3 — synchronous optimistic outbox over asynchronous encrypted persistence.
//
// MessageInputPanel remains the only replay/timer owner. This runtime provides
// its immediate queue API while serializing encrypted writes behind a one-time
// legacy migration + restart normalization.

import {
  clearLegacyOutbox,
  readOutbox as readLegacyOutbox,
  type OutboxEntry,
} from '../outbox-store.ts';
import { cloneLocalFirstJson } from './json-snapshot.ts';
import { createBrowserLocalFirstStore, type BrowserLocalFirstStore } from './indexeddb.ts';
import {
  EncryptedOutboxRepository,
  LOCAL_OUTBOX_MAX_ENTRIES,
  type LegacyOutboxSource,
} from './outbox.ts';

interface UserOutboxRuntime {
  storage: BrowserLocalFirstStore;
  repository: EncryptedOutboxRepository;
}

export class LocalFirstOutboxMigrationConflictError extends Error {
  constructor(readonly userId: string) {
    super('Encrypted and legacy outbox snapshots conflict');
    this.name = 'LocalFirstOutboxMigrationConflictError';
  }
}

export interface LocalFirstOutboxStorageStatus {
  userId: string;
  durable: boolean;
  backend: 'indexeddb' | 'memory';
  reason?: string;
  lastPersistenceError?: string;
}

const runtimes = new Map<string, Promise<UserOutboxRuntime>>();
const volatile = new Map<string, OutboxEntry[]>();
const generations = new Map<string, number>();
const chains = new Map<string, Promise<void>>();
const persistenceErrors = new Map<string, string>();

function requireUserId(userId: string): string {
  const normalized = String(userId ?? '').trim();
  if (!normalized) throw new Error('Outbox userId is required');
  return normalized;
}

function cloneEntries(entries: readonly OutboxEntry[]): OutboxEntry[] {
  return entries.map(entry => cloneLocalFirstJson(entry));
}

function sortEntries(entries: OutboxEntry[]): OutboxEntry[] {
  return entries.sort((a, b) => a.createdAt - b.createdAt || a.ackId.localeCompare(b.ackId));
}

function generation(userId: string): number {
  return generations.get(userId) ?? 0;
}

function bump(userId: string): number {
  const next = generation(userId) + 1;
  generations.set(userId, next);
  return next;
}

function legacySource(): LegacyOutboxSource {
  return {
    read: userId => readLegacyOutbox(userId),
    clear: userId => clearLegacyOutbox(userId),
  };
}

function notePersistenceError(userId: string, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Encrypted outbox persistence failed';
  persistenceErrors.set(userId, message);
  if (typeof document !== 'undefined') {
    document.dispatchEvent(new CustomEvent('bridge:outbox-persistence-error', {
      detail: { userId, message },
    }));
  }
}

function createRuntime(userIdInput: string): Promise<UserOutboxRuntime> {
  const userId = requireUserId(userIdInput);
  const existing = runtimes.get(userId);
  if (existing) return existing;

  const startedGeneration = generation(userId);
  const operation = createBrowserLocalFirstStore(userId).then(async storage => {
    const repository = new EncryptedOutboxRepository(userId, storage.store);
    const migration = await repository.migrateLegacy(legacySource());
    if (migration.status === 'conflict') {
      storage.store.close();
      throw new LocalFirstOutboxMigrationConflictError(userId);
    }

    const restored = await repository.restoreAfterRestart();
    if (generation(userId) === startedGeneration) {
      volatile.set(userId, cloneEntries(restored));
    }
    return { storage, repository };
  });

  // Failed initialization must be retryable after the caller surfaces it.
  void operation.catch(error => {
    if (runtimes.get(userId) === operation) runtimes.delete(userId);
    notePersistenceError(userId, error);
  });

  runtimes.set(userId, operation);
  return operation;
}

function enqueue(
  userId: string,
  runtime: Promise<UserOutboxRuntime>,
  task: (value: UserOutboxRuntime) => Promise<void>,
): void {
  const previous = chains.get(userId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      const value = await runtime;
      await task(value);
      persistenceErrors.delete(userId);
    })
    .catch(error => {
      notePersistenceError(userId, error);
    });

  chains.set(userId, next);
  void next.finally(() => {
    if (chains.get(userId) === next) chains.delete(userId);
  });
}

/**
 * Immediate active-session view. Legacy plaintext is read only as migration
 * input on first upgrade; no new plaintext is written here.
 */
export function readLocalFirstOutbox(userIdInput: string): OutboxEntry[] {
  const userId = requireUserId(userIdInput);
  const cached = volatile.get(userId);
  if (cached) return cloneEntries(cached);

  const legacy = sortEntries(cloneEntries(readLegacyOutbox(userId)));
  volatile.set(userId, legacy);
  return cloneEntries(legacy);
}

/**
 * Complete one-time encrypted migration and restart normalization before replay.
 */
export async function hydrateLocalFirstOutbox(userIdInput: string): Promise<OutboxEntry[]> {
  const userId = requireUserId(userIdInput);
  await createRuntime(userId);
  return readLocalFirstOutbox(userId);
}

export function putLocalFirstOutboxEntry(entry: OutboxEntry): boolean {
  const userId = requireUserId(entry.userId);
  // Start initialization before bumping generation so a late initial snapshot
  // cannot overwrite this newly accepted optimistic mutation.
  const runtime = createRuntime(userId);
  const entries = readLocalFirstOutbox(userId);
  const index = entries.findIndex(item => item.ackId === entry.ackId);
  if (index < 0 && entries.length >= LOCAL_OUTBOX_MAX_ENTRIES) return false;

  if (index >= 0) entries[index] = cloneLocalFirstJson(entry);
  else entries.push(cloneLocalFirstJson(entry));
  sortEntries(entries);
  bump(userId);
  volatile.set(userId, cloneEntries(entries));

  const snapshot = cloneEntries(entries);
  enqueue(userId, runtime, async value => {
    await value.repository.write(snapshot);
  });
  return true;
}

export function patchLocalFirstOutboxEntry(
  userIdInput: string,
  ackId: string,
  patch: Partial<Pick<OutboxEntry, 'state' | 'attempts' | 'lastAttemptAt' | 'lastError'>>,
): OutboxEntry | null {
  const userId = requireUserId(userIdInput);
  const runtime = createRuntime(userId);
  const entries = readLocalFirstOutbox(userId);
  const index = entries.findIndex(entry => entry.ackId === ackId);
  if (index < 0) return null;

  entries[index] = { ...entries[index], ...patch };
  bump(userId);
  volatile.set(userId, cloneEntries(entries));

  const snapshot = cloneEntries(entries);
  enqueue(userId, runtime, async value => {
    await value.repository.write(snapshot);
  });
  return cloneLocalFirstJson(entries[index]);
}

export function removeLocalFirstOutboxEntry(userIdInput: string, ackId: string): void {
  const userId = requireUserId(userIdInput);
  const runtime = createRuntime(userId);
  const entries = readLocalFirstOutbox(userId).filter(entry => entry.ackId !== ackId);
  bump(userId);
  volatile.set(userId, cloneEntries(entries));

  const snapshot = cloneEntries(entries);
  enqueue(userId, runtime, async value => {
    await value.repository.write(snapshot);
  });
}

export function localFirstOutboxForChannel(userId: string, channelId: string): OutboxEntry[] {
  return readLocalFirstOutbox(userId).filter(entry => entry.channelId === channelId);
}

export async function flushLocalFirstOutbox(userIdInput: string): Promise<void> {
  const userId = requireUserId(userIdInput);
  await (chains.get(userId) ?? Promise.resolve());
}

export async function localFirstOutboxStorageStatus(
  userIdInput: string,
): Promise<LocalFirstOutboxStorageStatus> {
  const userId = requireUserId(userIdInput);
  const runtime = await createRuntime(userId);
  return {
    userId,
    durable: runtime.storage.durable,
    backend: runtime.storage.backend,
    ...(runtime.storage.reason ? { reason: runtime.storage.reason } : {}),
    ...(persistenceErrors.get(userId)
      ? { lastPersistenceError: persistenceErrors.get(userId) }
      : {}),
  };
}

export function closeLocalFirstOutboxRuntime(userIdInput: string): void {
  const userId = String(userIdInput ?? '').trim();
  if (!userId) return;

  const runtime = runtimes.get(userId);
  const pending = chains.get(userId) ?? Promise.resolve();
  runtimes.delete(userId);
  volatile.delete(userId);
  generations.delete(userId);
  persistenceErrors.delete(userId);

  void pending
    .catch(() => undefined)
    .then(() => runtime)
    .then(value => value?.storage.store.close())
    .catch(() => undefined);
}

export function resetLocalFirstOutboxRuntimeForTests(): void {
  for (const [userId, runtime] of runtimes) {
    const pending = chains.get(userId) ?? Promise.resolve();
    void pending
      .catch(() => undefined)
      .then(() => runtime)
      .then(value => value.storage.store.close())
      .catch(() => undefined);
  }
  runtimes.clear();
  volatile.clear();
  generations.clear();
  chains.clear();
  persistenceErrors.clear();
}
