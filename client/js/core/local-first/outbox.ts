// P7 A3 — encrypted canonical outbox repository.
//
// The message protocol remains unchanged: ackId is still the idempotency key and
// MessageInputPanel remains the replay/timer owner. This module only changes
// durable at-rest representation from plaintext localStorage to one encrypted
// queue snapshot.

import type { OutboxEntry, OutboxState } from '../outbox-store.ts';
import type { EncryptedLocalStore } from './store.ts';

export const LOCAL_OUTBOX_VERSION = 1;
export const LOCAL_OUTBOX_RECORD_ID = 'queue';
export const LOCAL_OUTBOX_MAX_ENTRIES = 100;

export interface LocalOutboxSnapshot {
  v: typeof LOCAL_OUTBOX_VERSION;
  entries: OutboxEntry[];
}

export interface LegacyOutboxSource {
  read(userId: string): OutboxEntry[];
  clear(userId: string): void;
}

export interface OutboxMigrationResult {
  status: 'already-encrypted' | 'nothing-to-migrate' | 'migrated' | 'conflict';
  entries: OutboxEntry[];
}

function validState(value: unknown): value is OutboxState {
  return value === 'queued' || value === 'sending' || value === 'failed';
}

export function validLocalOutboxEntry(value: unknown, expectedUserId: string): value is OutboxEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<OutboxEntry>;
  if (entry.userId !== expectedUserId) return false;
  if (typeof entry.ackId !== 'string' || !entry.ackId || entry.ackId.length > 64) return false;
  if (typeof entry.channelId !== 'string' || !entry.channelId) return false;
  if (typeof entry.serverId !== 'string' || !entry.serverId) return false;
  if (!validState(entry.state)) return false;
  if (!['normal', 'file', 'sticker'].includes(String(entry.messageType))) return false;
  if (!['channel', 'dm', 'gdm'].includes(String(entry.draftKind))) return false;
  if (typeof entry.content !== 'string' || entry.content.length > 2000) return false;
  if (!Number.isFinite(entry.createdAt) || Number(entry.createdAt) < 0) return false;
  if (!Number.isFinite(entry.attempts) || Number(entry.attempts) < 0) return false;
  if (entry.lastAttemptAt !== undefined && !Number.isFinite(entry.lastAttemptAt)) return false;
  if (entry.lastError !== undefined && typeof entry.lastError !== 'string') return false;

  if (entry.replyToId !== undefined && typeof entry.replyToId !== 'string') return false;
  if (entry.replyPreview !== undefined) {
    if (!entry.replyPreview || typeof entry.replyPreview !== 'object') return false;
    if (typeof entry.replyPreview._id !== 'string' || !entry.replyPreview._id) return false;
    if (entry.replyPreview.displayName !== undefined && typeof entry.replyPreview.displayName !== 'string') return false;
    if (entry.replyPreview.content !== undefined && typeof entry.replyPreview.content !== 'string') return false;
  }

  if (entry.messageType === 'file') {
    if (typeof entry.fileUrl !== 'string' || !entry.fileUrl) return false;
    if (typeof entry.fileName !== 'string' || !entry.fileName) return false;
    if (entry.fileType !== undefined && typeof entry.fileType !== 'string') return false;
  }

  if (entry.messageType === 'sticker') {
    if (typeof entry.stickerPackId !== 'string' || !entry.stickerPackId) return false;
    if (typeof entry.stickerId !== 'string' || !entry.stickerId) return false;
    const sticker = entry.stickerSnapshot;
    if (!sticker || typeof sticker !== 'object') return false;
    if (
      typeof sticker.id !== 'string'
      || typeof sticker.packId !== 'string'
      || typeof sticker.name !== 'string'
      || typeof sticker.url !== 'string'
      || !Number.isFinite(sticker.width)
      || !Number.isFinite(sticker.height)
    ) return false;
  }

  return true;
}

function normalize(
  userId: string,
  entries: readonly OutboxEntry[],
): OutboxEntry[] {
  if (entries.length > LOCAL_OUTBOX_MAX_ENTRIES) {
    throw new Error('Local-first outbox is full');
  }

  const seen = new Set<string>();
  const result: OutboxEntry[] = [];
  for (const entry of entries) {
    if (!validLocalOutboxEntry(entry, userId)) {
      throw new Error('Invalid local-first outbox entry');
    }
    if (seen.has(entry.ackId)) throw new Error('Duplicate local-first outbox ackId');
    seen.add(entry.ackId);
    result.push(structuredClone(entry));
  }
  return result.sort((a, b) => a.createdAt - b.createdAt || a.ackId.localeCompare(b.ackId));
}

function sameEntries(a: readonly OutboxEntry[], b: readonly OutboxEntry[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class EncryptedOutboxRepository {
  constructor(
    readonly userId: string,
    private readonly store: EncryptedLocalStore,
  ) {
    if (!userId) throw new Error('Outbox userId is required');
  }

  async read(): Promise<OutboxEntry[]> {
    const raw = await this.store.getJson<unknown>('outbox', LOCAL_OUTBOX_RECORD_ID);
    if (raw === null) return [];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Invalid local-first outbox snapshot');
    }
    const snapshot = raw as Partial<LocalOutboxSnapshot>;
    if (snapshot.v !== LOCAL_OUTBOX_VERSION || !Array.isArray(snapshot.entries)) {
      throw new Error('Invalid local-first outbox snapshot');
    }
    return normalize(this.userId, snapshot.entries as OutboxEntry[]);
  }

  async write(entries: readonly OutboxEntry[]): Promise<OutboxEntry[]> {
    const normalized = normalize(this.userId, entries);
    if (normalized.length === 0) {
      await this.store.delete('outbox', LOCAL_OUTBOX_RECORD_ID);
      return [];
    }
    await this.store.putJson<LocalOutboxSnapshot>(
      'outbox',
      LOCAL_OUTBOX_RECORD_ID,
      { v: LOCAL_OUTBOX_VERSION, entries: normalized },
      Date.now(),
    );
    return normalized;
  }

  async put(entry: OutboxEntry): Promise<OutboxEntry[]> {
    if (!validLocalOutboxEntry(entry, this.userId)) throw new Error('Invalid local-first outbox entry');
    const entries = await this.read();
    const index = entries.findIndex(item => item.ackId === entry.ackId);
    if (index >= 0) entries[index] = structuredClone(entry);
    else {
      if (entries.length >= LOCAL_OUTBOX_MAX_ENTRIES) throw new Error('Local-first outbox is full');
      entries.push(structuredClone(entry));
    }
    return this.write(entries);
  }

  async patch(
    ackId: string,
    patch: Partial<Pick<OutboxEntry, 'state' | 'attempts' | 'lastAttemptAt' | 'lastError'>>,
  ): Promise<OutboxEntry | null> {
    const entries = await this.read();
    const index = entries.findIndex(entry => entry.ackId === ackId);
    if (index < 0) return null;
    const next = { ...entries[index], ...patch };
    if (!validLocalOutboxEntry(next, this.userId)) throw new Error('Invalid local-first outbox patch');
    entries[index] = next;
    await this.write(entries);
    return structuredClone(next);
  }

  async remove(ackId: string): Promise<void> {
    const entries = await this.read();
    await this.write(entries.filter(entry => entry.ackId !== ackId));
  }

  /**
   * A process restart cannot know whether a previous socket send reached the
   * server. Convert 'sending' back to 'queued' and replay the SAME ackId.
   */
  async restoreAfterRestart(): Promise<OutboxEntry[]> {
    const restored = (await this.read()).map(entry =>
      entry.state === 'sending' ? { ...entry, state: 'queued' as const } : entry,
    );
    await this.write(restored);
    return restored;
  }

  /**
   * Migrate the legacy single-array localStorage record.
   *
   * If encrypted data already exists and differs from the legacy source, leave
   * plaintext untouched and report a conflict instead of guessing which queue
   * is newer. The runtime can surface/reconcile that exceptional state.
   */
  async migrateLegacy(legacy: LegacyOutboxSource): Promise<OutboxMigrationResult> {
    const encrypted = await this.read();
    const legacyEntries = normalize(this.userId, legacy.read(this.userId));

    if (legacyEntries.length === 0) {
      return {
        status: encrypted.length ? 'already-encrypted' : 'nothing-to-migrate',
        entries: encrypted,
      };
    }

    if (encrypted.length) {
      if (sameEntries(encrypted, legacyEntries)) {
        legacy.clear(this.userId);
        if (legacy.read(this.userId).length !== 0) {
          throw new Error('Legacy outbox cleanup verification failed');
        }
        return { status: 'already-encrypted', entries: encrypted };
      }
      return { status: 'conflict', entries: encrypted };
    }

    const written = await this.write(legacyEntries);
    const verified = await this.read();
    if (!sameEntries(written, verified)) {
      throw new Error('Encrypted outbox migration verification failed');
    }

    legacy.clear(this.userId);
    if (legacy.read(this.userId).length !== 0) {
      throw new Error('Legacy outbox cleanup verification failed');
    }
    return { status: 'migrated', entries: verified };
  }
}
