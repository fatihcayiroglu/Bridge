// P7 A5 — serialized encrypted operation-log runtime.

import { createBrowserLocalFirstStore, type BrowserLocalFirstStore } from './indexeddb.ts';
import {
  EncryptedOperationLog,
  type LocalOperation,
  type LocalOperationState,
  type NewLocalOperation,
} from './operation-log.ts';

interface UserOperationRuntime {
  storage: BrowserLocalFirstStore;
  log: EncryptedOperationLog;
}

const runtimes = new Map<string, Promise<UserOperationRuntime>>();
const chains = new Map<string, Promise<void>>();

function userIdOf(value: string): string {
  const userId = String(value ?? '').trim();
  if (!userId) throw new Error('Operation userId is required');
  return userId;
}

function runtimeFor(userIdInput: string): Promise<UserOperationRuntime> {
  const userId = userIdOf(userIdInput);
  const existing = runtimes.get(userId);
  if (existing) return existing;
  const operation = createBrowserLocalFirstStore(userId).then(storage => ({
    storage,
    log: new EncryptedOperationLog(userId, storage.store),
  }));
  runtimes.set(userId, operation);
  return operation;
}

function serialize<T>(userIdInput: string, task: (runtime: UserOperationRuntime) => Promise<T>): Promise<T> {
  const userId = userIdOf(userIdInput);
  const previous = chains.get(userId) ?? Promise.resolve();
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const result = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });

  const next = previous
    .catch(() => undefined)
    .then(async () => {
      try {
        resolve(await task(await runtimeFor(userId)));
      } catch (error) {
        reject(error);
      }
    });
  chains.set(userId, next);
  void next.finally(() => {
    if (chains.get(userId) === next) chains.delete(userId);
  });
  return result;
}

export function enqueueLocalFirstOperation(input: NewLocalOperation): Promise<LocalOperation> {
  return serialize(input.userId, runtime => runtime.log.enqueue(input));
}

export function transitionLocalFirstOperation(
  userId: string,
  opId: string,
  state: LocalOperationState,
  patch?: { lastError?: string; supersededBy?: string; incrementAttempts?: boolean },
): Promise<LocalOperation> {
  return serialize(userId, runtime => runtime.log.transition(opId, state, patch));
}

export async function listActiveLocalFirstOperations(userIdInput: string): Promise<LocalOperation[]> {
  const userId = userIdOf(userIdInput);
  await (chains.get(userId) ?? Promise.resolve());
  return (await runtimeFor(userId)).log.listActive();
}

export function compactLocalFirstOperations(userId: string): Promise<void> {
  return serialize(userId, async runtime => { await runtime.log.compact(); });
}

export function closeLocalFirstOperationRuntime(userIdInput: string): void {
  const userId = String(userIdInput ?? '').trim();
  if (!userId) return;
  const runtime = runtimes.get(userId);
  const pending = chains.get(userId) ?? Promise.resolve();
  runtimes.delete(userId);
  chains.delete(userId);
  void pending.catch(() => undefined)
    .then(() => runtime)
    .then(value => value?.storage.store.close())
    .catch(() => undefined);
}

export function resetLocalFirstOperationRuntimeForTests(): void {
  for (const runtime of runtimes.values()) {
    void runtime.then(value => value.storage.store.close()).catch(() => undefined);
  }
  runtimes.clear();
  chains.clear();
}
