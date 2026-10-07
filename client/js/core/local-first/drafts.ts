// P7 A3 — encrypted draft repository and safe legacy migration.
//
// This module is asynchronous by design: physical local-first storage may be
// IndexedDB today and native SQLite later. UI ownership/timing remains in
// DraftManager; this module owns persistence semantics only.

import type { DraftIdentity } from '../draft-store.ts';
import type { EncryptedLocalStore } from './store.ts';

export const LOCAL_DRAFT_VERSION = 1;
export const LOCAL_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const LOCAL_DRAFT_MAX_LENGTH = 2000;

export interface LocalDraftSnapshot {
  v: typeof LOCAL_DRAFT_VERSION;
  text: string;
  savedAt: number;
  attachmentPending: boolean;
}

export interface LegacyDraftSource {
  read(identity: DraftIdentity): LocalDraftSnapshot | null;
  clear(identity: DraftIdentity): void;
}

export interface DraftMigrationResult {
  status: 'already-encrypted' | 'nothing-to-migrate' | 'migrated';
  snapshot: LocalDraftSnapshot | null;
}

function requireIdentity(identity: DraftIdentity): DraftIdentity {
  if (!identity?.userId || !identity.conversationId) throw new Error('Draft identity is incomplete');
  if (!['channel', 'dm', 'gdm'].includes(identity.kind)) throw new Error('Draft kind is invalid');
  if (identity.kind === 'channel' && !identity.serverId) throw new Error('Channel draft requires serverId');
  return identity;
}

export function localDraftRecordId(identity: DraftIdentity): string {
  const value = requireIdentity(identity);
  const scope = value.kind === 'channel' ? value.serverId! : value.kind;
  return [
    value.kind,
    encodeURIComponent(scope),
    encodeURIComponent(value.conversationId),
  ].join(':');
}

function normalizeSnapshot(value: unknown, now = Date.now()): LocalDraftSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Partial<LocalDraftSnapshot>;
  if (row.v !== LOCAL_DRAFT_VERSION || typeof row.text !== 'string') return null;
  if (!Number.isFinite(row.savedAt) || Number(row.savedAt) < 0) return null;
  if (typeof row.attachmentPending !== 'boolean') return null;

  const savedAt = Number(row.savedAt);
  if (savedAt > 0 && now - savedAt > LOCAL_DRAFT_MAX_AGE_MS) return null;
  return {
    v: LOCAL_DRAFT_VERSION,
    text: row.text.slice(0, LOCAL_DRAFT_MAX_LENGTH),
    savedAt,
    attachmentPending: row.attachmentPending,
  };
}

function sameSnapshot(a: LocalDraftSnapshot, b: LocalDraftSnapshot): boolean {
  return a.v === b.v
    && a.text === b.text
    && a.savedAt === b.savedAt
    && a.attachmentPending === b.attachmentPending;
}

export class EncryptedDraftRepository {
  constructor(private readonly store: EncryptedLocalStore) {}

  async read(identity: DraftIdentity, now = Date.now()): Promise<LocalDraftSnapshot | null> {
    requireIdentity(identity);
    const recordId = localDraftRecordId(identity);
    const raw = await this.store.getJson<unknown>('draft', recordId);
    if (raw === null) return null;

    const snapshot = normalizeSnapshot(raw, now);
    if (snapshot) return snapshot;

    // Invalid/stale draft content must not remain canonical.
    await this.store.delete('draft', recordId);
    return null;
  }

  async write(
    identity: DraftIdentity,
    text: string,
    attachmentPending: boolean,
    savedAt = Date.now(),
  ): Promise<LocalDraftSnapshot | null> {
    requireIdentity(identity);
    const normalizedText = typeof text === 'string'
      ? text.slice(0, LOCAL_DRAFT_MAX_LENGTH)
      : '';

    if (!normalizedText.trim() && attachmentPending !== true) {
      await this.clear(identity);
      return null;
    }

    const snapshot: LocalDraftSnapshot = {
      v: LOCAL_DRAFT_VERSION,
      text: normalizedText,
      savedAt,
      attachmentPending: attachmentPending === true,
    };
    await this.store.putJson('draft', localDraftRecordId(identity), snapshot, savedAt);
    return snapshot;
  }

  async clear(identity: DraftIdentity): Promise<void> {
    requireIdentity(identity);
    await this.store.delete('draft', localDraftRecordId(identity));
  }

  /**
   * Copy-verify-delete migration.
   *
   * The plaintext source is never deleted just because an encrypted write
   * returned. We read the encrypted value back through authenticated
   * decryption and compare the normalized payload before clearing legacy data.
   */
  async migrateLegacy(
    identity: DraftIdentity,
    legacy: LegacyDraftSource,
    now = Date.now(),
  ): Promise<DraftMigrationResult> {
    requireIdentity(identity);

    const encrypted = await this.read(identity, now);
    if (encrypted) return { status: 'already-encrypted', snapshot: encrypted };

    const candidate = legacy.read(identity);
    if (!candidate) return { status: 'nothing-to-migrate', snapshot: null };

    const normalized = normalizeSnapshot(candidate, now);
    if (!normalized) {
      // Do not destroy malformed legacy data here. Migration is intentionally
      // conservative; the legacy owner may have its own recovery policy.
      return { status: 'nothing-to-migrate', snapshot: null };
    }

    const written = await this.write(
      identity,
      normalized.text,
      normalized.attachmentPending,
      normalized.savedAt,
    );
    if (!written) return { status: 'nothing-to-migrate', snapshot: null };

    const verified = await this.read(identity, now);
    if (!verified || !sameSnapshot(verified, written)) {
      throw new Error('Encrypted draft migration verification failed');
    }

    legacy.clear(identity);
    return { status: 'migrated', snapshot: verified };
  }
}
