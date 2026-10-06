// P7 A4 — encrypted bounded message-history cache.
//
// This is a cache of previously-authorized, server-confirmed content. It is not
// an authorization source. Pending/failed optimistic rows stay in the canonical
// outbox and are intentionally not persisted here.

import type { EncryptedLocalStore } from './store.ts';

export const LOCAL_HISTORY_VERSION = 1;
export const LOCAL_HISTORY_MAX_MESSAGES = 200;
export const LOCAL_HISTORY_MAX_TOMBSTONES = 500;
export const LOCAL_HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CachedMessage {
  _id: string;
  channelId?: string;
  createdAt?: number | string;
  deletedAt?: unknown;
  pending?: unknown;
  failed?: unknown;
  [key: string]: unknown;
}

export interface HistoryTombstone {
  id: string;
  deletedAt: number;
}

export interface LocalHistorySnapshot {
  v: typeof LOCAL_HISTORY_VERSION;
  channelId: string;
  savedAt: number;
  messages: CachedMessage[];
  tombstones: HistoryTombstone[];
}

function requireId(value: string, label: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > 512) throw new Error(`${label} is too large`);
  return normalized;
}

export function historyRecordId(channelId: string): string {
  return `channel:${encodeURIComponent(requireId(channelId, 'channelId'))}`;
}

function messageTime(message: CachedMessage): number {
  const value = Number(message.createdAt ?? 0);
  return Number.isFinite(value) ? value : 0;
}

function cacheableMessage(value: unknown, channelId: string): value is CachedMessage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as CachedMessage;
  if (typeof message._id !== 'string' || !message._id || message._id.length > 512) return false;
  if (message._id.startsWith('pending:') || message.pending === true || message.failed === true) return false;
  if (message.deletedAt) return false;
  if (message.channelId !== undefined && String(message.channelId) !== channelId) return false;
  return true;
}

function normalizeTombstones(
  values: readonly HistoryTombstone[],
  now: number,
): HistoryTombstone[] {
  const newest = new Map<string, number>();
  for (const value of values) {
    if (!value || typeof value.id !== 'string' || !value.id) continue;
    const deletedAt = Number(value.deletedAt);
    if (!Number.isFinite(deletedAt) || deletedAt < 0) continue;
    if (now - deletedAt > LOCAL_HISTORY_MAX_AGE_MS) continue;
    newest.set(value.id, Math.max(newest.get(value.id) ?? 0, deletedAt));
  }
  return [...newest.entries()]
    .map(([id, deletedAt]) => ({ id, deletedAt }))
    .sort((a, b) => b.deletedAt - a.deletedAt || a.id.localeCompare(b.id))
    .slice(0, LOCAL_HISTORY_MAX_TOMBSTONES);
}

function normalizeMessages(
  channelId: string,
  values: readonly unknown[],
  tombstones: readonly HistoryTombstone[],
): CachedMessage[] {
  const deleted = new Set(tombstones.map(item => item.id));
  const byId = new Map<string, CachedMessage>();

  for (const value of values) {
    if (!cacheableMessage(value, channelId) || deleted.has(value._id)) continue;
    byId.set(value._id, structuredClone(value));
  }

  return [...byId.values()]
    .sort((a, b) => messageTime(a) - messageTime(b) || a._id.localeCompare(b._id))
    .slice(-LOCAL_HISTORY_MAX_MESSAGES);
}

function validateSnapshot(
  value: unknown,
  channelId: string,
  now: number,
): LocalHistorySnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid local-first history snapshot');
  }
  const snapshot = value as Partial<LocalHistorySnapshot>;
  if (
    snapshot.v !== LOCAL_HISTORY_VERSION
    || snapshot.channelId !== channelId
    || !Number.isFinite(snapshot.savedAt)
    || !Array.isArray(snapshot.messages)
    || !Array.isArray(snapshot.tombstones)
  ) {
    throw new Error('Invalid local-first history snapshot');
  }

  const savedAt = Number(snapshot.savedAt);
  if (savedAt < 0 || now - savedAt > LOCAL_HISTORY_MAX_AGE_MS) return null;

  const tombstones = normalizeTombstones(snapshot.tombstones, now);
  const messages = normalizeMessages(channelId, snapshot.messages, tombstones);
  return {
    v: LOCAL_HISTORY_VERSION,
    channelId,
    savedAt,
    messages,
    tombstones,
  };
}

export class EncryptedHistoryRepository {
  constructor(private readonly store: EncryptedLocalStore) {}

  async read(channelIdInput: string, now = Date.now()): Promise<LocalHistorySnapshot | null> {
    const channelId = requireId(channelIdInput, 'channelId');
    const recordId = historyRecordId(channelId);
    const raw = await this.store.getJson<unknown>('history', recordId);
    if (raw === null) return null;

    const snapshot = validateSnapshot(raw, channelId, now);
    if (snapshot) return snapshot;

    // Expired cache is disposable. Confirmed server history can always be
    // fetched again; unlike outbox/drafts this is safe eviction.
    await this.store.delete('history', recordId);
    return null;
  }

  async replaceFromServer(
    channelIdInput: string,
    messages: readonly unknown[],
    now = Date.now(),
  ): Promise<LocalHistorySnapshot> {
    const channelId = requireId(channelIdInput, 'channelId');
    const current = await this.read(channelId, now);
    const tombstones = normalizeTombstones(current?.tombstones ?? [], now);
    const normalized = normalizeMessages(channelId, messages, tombstones);

    const snapshot: LocalHistorySnapshot = {
      v: LOCAL_HISTORY_VERSION,
      channelId,
      savedAt: now,
      messages: normalized,
      tombstones,
    };
    await this.store.putJson('history', historyRecordId(channelId), snapshot, now);
    return snapshot;
  }

  async mergeOlder(
    channelIdInput: string,
    messages: readonly unknown[],
    now = Date.now(),
  ): Promise<LocalHistorySnapshot> {
    const channelId = requireId(channelIdInput, 'channelId');
    const current = await this.read(channelId, now);
    const tombstones = normalizeTombstones(current?.tombstones ?? [], now);
    const merged = normalizeMessages(
      channelId,
      [...(current?.messages ?? []), ...messages],
      tombstones,
    );
    const snapshot: LocalHistorySnapshot = {
      v: LOCAL_HISTORY_VERSION,
      channelId,
      savedAt: now,
      messages: merged,
      tombstones,
    };
    await this.store.putJson('history', historyRecordId(channelId), snapshot, now);
    return snapshot;
  }

  async append(
    channelIdInput: string,
    message: unknown,
    now = Date.now(),
  ): Promise<LocalHistorySnapshot | null> {
    const channelId = requireId(channelIdInput, 'channelId');
    if (!cacheableMessage(message, channelId)) return this.read(channelId, now);

    const current = await this.read(channelId, now);
    const tombstones = normalizeTombstones(current?.tombstones ?? [], now);
    if (tombstones.some(item => item.id === message._id)) return current;

    const messages = normalizeMessages(
      channelId,
      [...(current?.messages ?? []), message],
      tombstones,
    );
    const snapshot: LocalHistorySnapshot = {
      v: LOCAL_HISTORY_VERSION,
      channelId,
      savedAt: now,
      messages,
      tombstones,
    };
    await this.store.putJson('history', historyRecordId(channelId), snapshot, now);
    return snapshot;
  }

  async update(
    channelIdInput: string,
    message: unknown,
    now = Date.now(),
  ): Promise<LocalHistorySnapshot | null> {
    const channelId = requireId(channelIdInput, 'channelId');
    if (!cacheableMessage(message, channelId)) return this.read(channelId, now);

    const current = await this.read(channelId, now);
    if (!current) return null;
    if (current.tombstones.some(item => item.id === message._id)) return current;

    const index = current.messages.findIndex(item => item._id === message._id);
    if (index < 0) return current;
    const next = current.messages.slice();
    next[index] = { ...next[index], ...structuredClone(message) };

    const snapshot: LocalHistorySnapshot = {
      ...current,
      savedAt: now,
      messages: normalizeMessages(channelId, next, current.tombstones),
    };
    await this.store.putJson('history', historyRecordId(channelId), snapshot, now);
    return snapshot;
  }

  async tombstone(
    channelIdInput: string,
    messageIdInput: string,
    deletedAt = Date.now(),
  ): Promise<LocalHistorySnapshot> {
    const channelId = requireId(channelIdInput, 'channelId');
    const messageId = requireId(messageIdInput, 'messageId');
    const current = await this.read(channelId, deletedAt);
    const tombstones = normalizeTombstones([
      ...(current?.tombstones ?? []),
      { id: messageId, deletedAt },
    ], deletedAt);
    const messages = normalizeMessages(
      channelId,
      (current?.messages ?? []).filter(message => message._id !== messageId),
      tombstones,
    );

    const snapshot: LocalHistorySnapshot = {
      v: LOCAL_HISTORY_VERSION,
      channelId,
      savedAt: deletedAt,
      messages,
      tombstones,
    };
    await this.store.putJson('history', historyRecordId(channelId), snapshot, deletedAt);
    return snapshot;
  }

  async listAll(now = Date.now()): Promise<LocalHistorySnapshot[]> {
    const rows = await this.store.list<unknown>('history');
    const snapshots: LocalHistorySnapshot[] = [];

    for (const row of rows) {
      if (!row.value || typeof row.value !== 'object' || Array.isArray(row.value)) {
        throw new Error('Invalid local-first history snapshot');
      }
      const rawChannelId = (row.value as { channelId?: unknown }).channelId;
      if (typeof rawChannelId !== 'string' || !rawChannelId) {
        throw new Error('Invalid local-first history channel');
      }
      if (row.recordId !== historyRecordId(rawChannelId)) {
        throw new Error('Local-first history record id mismatch');
      }

      const snapshot = validateSnapshot(row.value, rawChannelId, now);
      if (!snapshot) {
        await this.store.delete('history', row.recordId);
        continue;
      }
      snapshots.push(snapshot);
    }

    return snapshots.sort((a, b) => b.savedAt - a.savedAt || a.channelId.localeCompare(b.channelId));
  }

  async clearChannel(channelId: string): Promise<void> {
    await this.store.delete('history', historyRecordId(channelId));
  }
}
