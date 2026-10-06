// P7 A3 — shared draft runtime.
//
// UI components keep synchronous local state, while persistence is asynchronous
// and encrypted. The legacy localStorage store is read-only here and exists
// solely as a copy-verify-delete migration source.

import {
  clearDraft as clearLegacyDraft,
  readDraftSnapshot,
  type DraftIdentity,
} from '../draft-store.ts';
import { createBrowserLocalFirstStore, type BrowserLocalFirstStore } from './indexeddb.ts';
import { LocalFirstDraftSession } from './draft-session.ts';
import {
  type LegacyDraftSource,
  type LocalDraftSnapshot,
  localDraftRecordId,
} from './drafts.ts';

interface UserDraftRuntime {
  storage: BrowserLocalFirstStore;
  session: LocalFirstDraftSession;
}

export interface LocalFirstDraftStorageStatus {
  userId: string;
  durable: boolean;
  backend: 'indexeddb' | 'memory';
  reason?: string;
}

const runtimes = new Map<string, Promise<UserDraftRuntime>>();
const volatile = new Map<string, LocalDraftSnapshot | null>();
const generations = new Map<string, number>();

function stableIdentity(identity: DraftIdentity): DraftIdentity {
  if (!identity.userId || !identity.conversationId) throw new Error('Draft identity is incomplete');
  if (identity.kind === 'channel' && !identity.serverId) throw new Error('Channel draft requires serverId');
  return {
    userId: identity.userId,
    kind: identity.kind,
    conversationId: identity.conversationId,
    ...(identity.serverId ? { serverId: identity.serverId } : {}),
  };
}

function legacySource(): LegacyDraftSource {
  return {
    read(identity) {
      const row = readDraftSnapshot(identity);
      if (!row) return null;
      return {
        v: 1,
        text: row.text,
        savedAt: row.savedAt,
        attachmentPending: row.attachmentPending,
      };
    },
    clear(identity) {
      clearLegacyDraft(identity);
    },
  };
}

function generation(key: string): number {
  return generations.get(key) ?? 0;
}

function bump(key: string): number {
  const next = generation(key) + 1;
  generations.set(key, next);
  return next;
}

function createRuntime(userId: string): Promise<UserDraftRuntime> {
  const existing = runtimes.get(userId);
  if (existing) return existing;

  const operation = createBrowserLocalFirstStore(userId).then(storage => ({
    storage,
    session: new LocalFirstDraftSession(
      // Avoid a second storage owner: the repository uses the exact store
      // instance whose durability/capability result we report.
      new (requireRepository())(storage.store),
      legacySource(),
    ),
  }));
  runtimes.set(userId, operation);
  return operation;
}

// Kept as a tiny function to make the construction site explicit without
// exposing physical storage details to callers.
function requireRepository(): typeof import('./drafts.ts').EncryptedDraftRepository {
  // Static import semantics without a top-level circular-looking constructor
  // alias in generated docs/bundles.
  return EncryptedDraftRepositoryRef;
}

import { EncryptedDraftRepository as EncryptedDraftRepositoryRef } from './drafts.ts';

/**
 * Synchronous best-effort view for render paths.
 *
 * Before the encrypted backend hydrates, a legacy plaintext snapshot may be
 * returned so upgrades do not make an existing draft appear lost. No new
 * plaintext is written by this runtime.
 */
export function peekLocalFirstDraft(identity: DraftIdentity): LocalDraftSnapshot | null {
  const stable = stableIdentity(identity);
  const key = localDraftRecordId(stable);
  if (volatile.has(key)) return volatile.get(key) ?? null;

  const legacy = legacySource().read(stable);
  if (legacy) volatile.set(key, legacy);
  return legacy;
}

/**
 * Load encrypted state and migrate a legacy record if one exists.
 * A late hydrate can never replace newer in-session user input.
 */
export async function hydrateLocalFirstDraft(identity: DraftIdentity): Promise<LocalDraftSnapshot | null> {
  const stable = stableIdentity(identity);
  const key = localDraftRecordId(stable);
  const startedGeneration = generation(key);
  const runtime = await createRuntime(stable.userId);
  const snapshot = await runtime.session.hydrate(stable);

  if (generation(key) === startedGeneration) volatile.set(key, snapshot);
  return volatile.has(key) ? volatile.get(key) ?? null : snapshot;
}

function nextSnapshot(
  identity: DraftIdentity,
  text: string,
  attachmentPending: boolean,
  savedAt = Date.now(),
): LocalDraftSnapshot | null {
  const stable = stableIdentity(identity);
  const normalizedText = typeof text === 'string' ? text.slice(0, 2000) : '';
  if (!normalizedText.trim() && attachmentPending !== true) return null;
  return {
    v: 1,
    text: normalizedText,
    savedAt,
    attachmentPending: attachmentPending === true,
  };
}

/**
 * Immediate cache update, asynchronous encrypted persistence.
 * Returns the value visible to the UI right now.
 */
export function persistLocalFirstDraft(
  identity: DraftIdentity,
  text: string,
  attachmentPending = false,
  savedAt = Date.now(),
): LocalDraftSnapshot | null {
  const stable = stableIdentity(identity);
  const key = localDraftRecordId(stable);
  const snapshot = nextSnapshot(stable, text, attachmentPending, savedAt);
  bump(key);
  volatile.set(key, snapshot);

  void createRuntime(stable.userId).then(runtime => {
    runtime.session.set(stable, text, attachmentPending, savedAt);
  });

  return snapshot;
}

export function persistLocalFirstDraftText(
  identity: DraftIdentity,
  text: string,
  savedAt = Date.now(),
): LocalDraftSnapshot | null {
  const existing = peekLocalFirstDraft(identity);
  return persistLocalFirstDraft(identity, text, existing?.attachmentPending === true, savedAt);
}

export function persistLocalFirstDraftAttachment(
  identity: DraftIdentity,
  attachmentPending: boolean,
  savedAt = Date.now(),
): LocalDraftSnapshot | null {
  const existing = peekLocalFirstDraft(identity);
  return persistLocalFirstDraft(identity, existing?.text ?? '', attachmentPending, savedAt);
}

export function clearLocalFirstDraft(identity: DraftIdentity): void {
  const stable = stableIdentity(identity);
  const key = localDraftRecordId(stable);
  bump(key);
  volatile.set(key, null);
  void createRuntime(stable.userId).then(runtime => runtime.session.clear(stable));
}

export async function flushLocalFirstDraft(identity: DraftIdentity): Promise<void> {
  const stable = stableIdentity(identity);
  const runtime = await createRuntime(stable.userId);
  await runtime.session.flush(stable);
}

export async function localFirstDraftStorageStatus(userId: string): Promise<LocalFirstDraftStorageStatus> {
  const runtime = await createRuntime(userId);
  return {
    userId,
    durable: runtime.storage.durable,
    backend: runtime.storage.backend,
    ...(runtime.storage.reason ? { reason: runtime.storage.reason } : {}),
  };
}

/**
 * Logout/account switch lifecycle. Persisted encrypted records remain available
 * for the same account's future login, while active DB handles/session caches
 * are released so another account cannot reuse in-memory state.
 */
export function closeLocalFirstDraftRuntime(userId: string): void {
  if (!userId) return;
  const runtime = runtimes.get(userId);
  runtimes.delete(userId);

  void runtime?.then(value => value.storage.store.close()).catch(() => undefined);

  const prefix = `u:${encodeURIComponent(userId)}|`;
  for (const key of volatile.keys()) {
    if (key.startsWith(prefix)) volatile.delete(key);
  }
  for (const key of generations.keys()) {
    if (key.startsWith(prefix)) generations.delete(key);
  }
}

/** Test-only reset for module singleton state. */
export function resetLocalFirstDraftRuntimeForTests(): void {
  for (const runtime of runtimes.values()) {
    void runtime.then(value => value.storage.store.close()).catch(() => undefined);
  }
  runtimes.clear();
  volatile.clear();
  generations.clear();
}
