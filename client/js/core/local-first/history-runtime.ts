// P7 A4 — per-account history runtime with serialized per-channel writes.

import { createBrowserLocalFirstStore, type BrowserLocalFirstStore } from './indexeddb.ts';
import {
  EncryptedHistoryRepository,
  type LocalHistorySnapshot,
} from './history.ts';

interface UserHistoryRuntime {
  storage: BrowserLocalFirstStore;
  repository: EncryptedHistoryRepository;
}

const runtimes = new Map<string, Promise<UserHistoryRuntime>>();
const chains = new Map<string, Promise<void>>();

function requireUserId(value: string): string {
  const userId = String(value ?? '').trim();
  if (!userId) throw new Error('History userId is required');
  return userId;
}

function channelKey(userId: string, channelId: string): string {
  return `${requireUserId(userId)}|${String(channelId ?? '').trim()}`;
}

function createRuntime(userIdInput: string): Promise<UserHistoryRuntime> {
  const userId = requireUserId(userIdInput);
  const existing = runtimes.get(userId);
  if (existing) return existing;
  const operation = createBrowserLocalFirstStore(userId).then(storage => ({
    storage,
    repository: new EncryptedHistoryRepository(storage.store),
  }));
  runtimes.set(userId, operation);
  return operation;
}

function enqueue(
  userId: string,
  channelId: string,
  task: (runtime: UserHistoryRuntime) => Promise<void>,
): Promise<void> {
  const key = channelKey(userId, channelId);
  const previous = chains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(async () => {
    const runtime = await createRuntime(userId);
    await task(runtime);
  });
  chains.set(key, next);
  void next.finally(() => {
    if (chains.get(key) === next) chains.delete(key);
  });
  return next;
}

export async function readLocalFirstHistory(
  userId: string,
  channelId: string,
): Promise<LocalHistorySnapshot | null> {
  await (chains.get(channelKey(userId, channelId)) ?? Promise.resolve());
  return (await createRuntime(userId)).repository.read(channelId);
}

export function replaceLocalFirstHistory(
  userId: string,
  channelId: string,
  messages: readonly unknown[],
): Promise<void> {
  return enqueue(userId, channelId, async runtime => {
    await runtime.repository.replaceFromServer(channelId, messages);
  });
}

export function mergeOlderLocalFirstHistory(
  userId: string,
  channelId: string,
  messages: readonly unknown[],
): Promise<void> {
  return enqueue(userId, channelId, async runtime => {
    await runtime.repository.mergeOlder(channelId, messages);
  });
}

export function appendLocalFirstHistory(
  userId: string,
  channelId: string,
  message: unknown,
): Promise<void> {
  return enqueue(userId, channelId, async runtime => {
    await runtime.repository.append(channelId, message);
  });
}

export function updateLocalFirstHistory(
  userId: string,
  channelId: string,
  message: unknown,
): Promise<void> {
  return enqueue(userId, channelId, async runtime => {
    await runtime.repository.update(channelId, message);
  });
}

export function tombstoneLocalFirstHistory(
  userId: string,
  channelId: string,
  messageId: string,
): Promise<void> {
  return enqueue(userId, channelId, async runtime => {
    await runtime.repository.tombstone(channelId, messageId);
  });
}

export function clearLocalFirstHistoryChannel(
  userId: string,
  channelId: string,
): Promise<void> {
  return enqueue(userId, channelId, async runtime => {
    await runtime.repository.clearChannel(channelId);
  });
}

export async function localFirstHistoryStorageStatus(userId: string) {
  const runtime = await createRuntime(userId);
  return {
    userId,
    durable: runtime.storage.durable,
    backend: runtime.storage.backend,
    ...(runtime.storage.reason ? { reason: runtime.storage.reason } : {}),
  };
}

export function closeLocalFirstHistoryRuntime(userIdInput: string): void {
  const userId = String(userIdInput ?? '').trim();
  if (!userId) return;
  const runtime = runtimes.get(userId);
  runtimes.delete(userId);

  const pending = [...chains.entries()]
    .filter(([key]) => key.startsWith(`${userId}|`))
    .map(([, promise]) => promise.catch(() => undefined));
  for (const key of [...chains.keys()]) {
    if (key.startsWith(`${userId}|`)) chains.delete(key);
  }

  void Promise.all(pending)
    .then(() => runtime)
    .then(value => value?.storage.store.close())
    .catch(() => undefined);
}

export function resetLocalFirstHistoryRuntimeForTests(): void {
  for (const runtime of runtimes.values()) {
    void runtime.then(value => value.storage.store.close()).catch(() => undefined);
  }
  runtimes.clear();
  chains.clear();
}
