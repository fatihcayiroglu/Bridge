// P7 A3 — synchronous UI cache over asynchronous encrypted draft persistence.
//
// DraftManager/MessageInputPanel need immediate reads and writes so typing never
// waits on IndexedDB/SQLite. This session gives them that synchronous surface
// while serializing persistence per conversation in the background.

import type { DraftIdentity } from '../draft-store.ts';
import {
  EncryptedDraftRepository,
  localDraftRecordId,
  type LegacyDraftSource,
  type LocalDraftSnapshot,
} from './drafts.ts';

export interface DraftSessionEvents {
  onHydrated?(identity: DraftIdentity, snapshot: LocalDraftSnapshot | null): void;
  onPersistenceError?(identity: DraftIdentity, error: unknown): void;
}

function cloneIdentity(identity: DraftIdentity): DraftIdentity {
  return {
    userId: identity.userId,
    kind: identity.kind,
    conversationId: identity.conversationId,
    ...(identity.serverId ? { serverId: identity.serverId } : {}),
  };
}

function sameSnapshot(a: LocalDraftSnapshot | null, b: LocalDraftSnapshot | null): boolean {
  if (a === null || b === null) return a === b;
  return a.v === b.v
    && a.text === b.text
    && a.savedAt === b.savedAt
    && a.attachmentPending === b.attachmentPending;
}

export class LocalFirstDraftSession {
  private readonly cache = new Map<string, LocalDraftSnapshot | null>();
  private readonly generations = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly hydrating = new Map<string, Promise<LocalDraftSnapshot | null>>();

  constructor(
    private readonly repository: EncryptedDraftRepository,
    private readonly legacy: LegacyDraftSource,
    private readonly events: DraftSessionEvents = {},
  ) {}

  /**
   * Returns:
   * - snapshot/null when the local synchronous cache is authoritative in-session;
   * - undefined when encrypted state still needs asynchronous hydration.
   */
  peek(identity: DraftIdentity): LocalDraftSnapshot | null | undefined {
    const key = localDraftRecordId(identity);
    return this.cache.has(key) ? this.cache.get(key) : undefined;
  }

  private generation(key: string): number {
    return this.generations.get(key) ?? 0;
  }

  private bump(key: string): number {
    const next = this.generation(key) + 1;
    this.generations.set(key, next);
    return next;
  }

  private enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task);

    this.chains.set(key, next);
    void next.finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    return next;
  }

  /**
   * Hydrate encrypted state (and copy-verify-delete legacy plaintext when
   * present). A late hydration can never overwrite text typed after it started.
   */
  hydrate(identity: DraftIdentity): Promise<LocalDraftSnapshot | null> {
    const stableIdentity = cloneIdentity(identity);
    const key = localDraftRecordId(stableIdentity);
    const cached = this.peek(stableIdentity);
    if (cached !== undefined) return Promise.resolve(cached);

    const existing = this.hydrating.get(key);
    if (existing) return existing;

    const startedGeneration = this.generation(key);
    const operation = new Promise<LocalDraftSnapshot | null>((resolve) => {
      void this.enqueue(key, async () => {
        try {
          const result = await this.repository.migrateLegacy(stableIdentity, this.legacy);
          const snapshot = result.snapshot ?? await this.repository.read(stableIdentity);

          if (this.generation(key) === startedGeneration) {
            this.cache.set(key, snapshot);
            this.events.onHydrated?.(stableIdentity, snapshot);
          }
          resolve(this.peek(stableIdentity) ?? snapshot);
        } catch (error) {
          this.events.onPersistenceError?.(stableIdentity, error);
          // Legacy remains untouched on migration failure. Expose it to the
          // current session if available, but do not claim encrypted hydration.
          const fallback = this.legacy.read(stableIdentity);
          if (this.generation(key) === startedGeneration && fallback) {
            this.cache.set(key, fallback);
            this.events.onHydrated?.(stableIdentity, fallback);
          }
          resolve(this.peek(stableIdentity) ?? fallback ?? null);
        }
      });
    }).finally(() => {
      if (this.hydrating.get(key) === operation) this.hydrating.delete(key);
    });

    this.hydrating.set(key, operation);
    return operation;
  }

  /**
   * Immediate in-session write + ordered encrypted persistence.
   *
   * The legacy plaintext copy is cleared only after authenticated read-back of
   * the newest encrypted value.
   */
  set(
    identity: DraftIdentity,
    text: string,
    attachmentPending: boolean,
    savedAt = Date.now(),
  ): LocalDraftSnapshot | null {
    const stableIdentity = cloneIdentity(identity);
    const key = localDraftRecordId(stableIdentity);
    const normalizedText = typeof text === 'string' ? text.slice(0, 2000) : '';
    const snapshot: LocalDraftSnapshot | null =
      !normalizedText.trim() && attachmentPending !== true
        ? null
        : {
            v: 1,
            text: normalizedText,
            savedAt,
            attachmentPending: attachmentPending === true,
          };

    this.bump(key);
    this.cache.set(key, snapshot);

    void this.enqueue(key, async () => {
      try {
        if (snapshot === null) {
          await this.repository.clear(stableIdentity);
          this.legacy.clear(stableIdentity);
          return;
        }

        const written = await this.repository.write(
          stableIdentity,
          snapshot.text,
          snapshot.attachmentPending,
          snapshot.savedAt,
        );
        const verified = await this.repository.read(stableIdentity, snapshot.savedAt);
        if (!sameSnapshot(written, verified)) {
          throw new Error('Encrypted draft write verification failed');
        }
        this.legacy.clear(stableIdentity);
      } catch (error) {
        this.events.onPersistenceError?.(stableIdentity, error);
      }
    });

    return snapshot;
  }

  clear(identity: DraftIdentity): void {
    this.set(identity, '', false);
  }

  async flush(identity?: DraftIdentity): Promise<void> {
    if (identity) {
      await (this.chains.get(localDraftRecordId(identity)) ?? Promise.resolve());
      return;
    }
    await Promise.all([...this.chains.values()].map(promise => promise.catch(() => undefined)));
  }
}
