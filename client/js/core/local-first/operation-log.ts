// P7 A5 — encrypted operation log for non-send mutations.
//
// IMPORTANT: message send is intentionally NOT an operation kind here.
// The canonical encrypted outbox remains the single replay owner for send/ackId.
// This log covers edit/delete/reaction desired-state operations only.

import type { EncryptedLocalStore } from './store.ts';

export const LOCAL_OPLOG_VERSION = 1;
export const LOCAL_OPLOG_MAX_ACTIVE = 200;
export const LOCAL_OPLOG_MAX_TOTAL = 500;
export const LOCAL_OPLOG_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type LocalOperationKind =
  | 'edit-message'
  | 'delete-message'
  | 'reaction-state';

export type LocalOperationState =
  | 'queued'
  | 'sending'
  | 'applied'
  | 'rejected'
  | 'superseded';

export interface EditMessagePayload {
  content: string;
  /**
   * Authoritative version the editor saw before changing the message:
   * editedAt when present, otherwise createdAt.
   */
  baseVersion: number;
}

export interface DeleteMessagePayload {
  reason?: string;
}

export interface ReactionStatePayload {
  emoji: string;
  desired: boolean;
}

export type LocalOperationPayload =
  | EditMessagePayload
  | DeleteMessagePayload
  | ReactionStatePayload;

export interface LocalOperation {
  v: typeof LOCAL_OPLOG_VERSION;
  opId: string;
  userId: string;
  channelId: string;
  targetId: string;
  kind: LocalOperationKind;
  state: LocalOperationState;
  payload: LocalOperationPayload;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  lastError?: string;
  supersededBy?: string;
}

export interface NewLocalOperation {
  opId: string;
  userId: string;
  channelId: string;
  targetId: string;
  kind: LocalOperationKind;
  payload: LocalOperationPayload;
  createdAt?: number;
}

const ACTIVE_STATES = new Set<LocalOperationState>(['queued', 'sending']);
const TERMINAL_STATES = new Set<LocalOperationState>(['applied', 'rejected', 'superseded']);

function required(value: string, label: string, max = 512): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  if (normalized.length > max) throw new Error(`${label} is too large`);
  return normalized;
}

function validState(value: unknown): value is LocalOperationState {
  return value === 'queued'
    || value === 'sending'
    || value === 'applied'
    || value === 'rejected'
    || value === 'superseded';
}

function normalizePayload(
  kind: LocalOperationKind,
  payload: LocalOperationPayload,
): LocalOperationPayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Operation payload is invalid');
  }

  if (kind === 'edit-message') {
    const content = String((payload as EditMessagePayload).content ?? '');
    const baseVersion = Number((payload as EditMessagePayload).baseVersion);
    if (
      !content.trim()
      || content.length > 2000
      || !Number.isSafeInteger(baseVersion)
      || baseVersion < 0
    ) throw new Error('Edit payload is invalid');
    return { content, baseVersion };
  }

  if (kind === 'delete-message') {
    const reasonRaw = (payload as DeleteMessagePayload).reason;
    if (reasonRaw === undefined) return {};
    const reason = String(reasonRaw).trim();
    if (reason.length > 200) throw new Error('Delete reason is too large');
    return reason ? { reason } : {};
  }

  const emoji = String((payload as ReactionStatePayload).emoji ?? '').trim();
  const desired = (payload as ReactionStatePayload).desired;
  if (!emoji || emoji.length > 10 || typeof desired !== 'boolean') {
    throw new Error('Reaction payload is invalid');
  }
  return { emoji, desired };
}

function normalizeOperation(value: LocalOperation): LocalOperation {
  const kind = value.kind;
  if (!['edit-message', 'delete-message', 'reaction-state'].includes(kind)) {
    throw new Error('Operation kind is invalid');
  }
  if (!validState(value.state)) throw new Error('Operation state is invalid');
  const createdAt = Number(value.createdAt);
  const updatedAt = Number(value.updatedAt);
  const attempts = Number(value.attempts);
  if (
    !Number.isFinite(createdAt) || createdAt < 0
    || !Number.isFinite(updatedAt) || updatedAt < createdAt
    || !Number.isSafeInteger(attempts) || attempts < 0
  ) {
    throw new Error('Operation timestamps/attempts are invalid');
  }

  return {
    v: LOCAL_OPLOG_VERSION,
    opId: required(value.opId, 'opId', 128),
    userId: required(value.userId, 'userId'),
    channelId: required(value.channelId, 'channelId'),
    targetId: required(value.targetId, 'targetId'),
    kind,
    state: value.state,
    payload: normalizePayload(kind, value.payload),
    createdAt,
    updatedAt,
    attempts,
    ...(value.lastError ? { lastError: String(value.lastError).slice(0, 500) } : {}),
    ...(value.supersededBy ? { supersededBy: required(value.supersededBy, 'supersededBy', 128) } : {}),
  };
}

function sameIdentityAndPayload(a: LocalOperation, b: LocalOperation): boolean {
  return a.opId === b.opId
    && a.userId === b.userId
    && a.channelId === b.channelId
    && a.targetId === b.targetId
    && a.kind === b.kind
    && JSON.stringify(a.payload) === JSON.stringify(b.payload);
}

function transitionAllowed(from: LocalOperationState, to: LocalOperationState): boolean {
  if (from === to) return true;
  // queued -> applied covers a late authoritative confirmation racing with a
  // local disconnect that already re-queued the operation.
  if (from === 'queued') return to === 'sending' || to === 'applied' || to === 'rejected' || to === 'superseded';
  if (from === 'sending') return to === 'queued' || to === 'applied' || to === 'rejected' || to === 'superseded';
  return false;
}

function desiredKey(operation: LocalOperation): string {
  if (operation.kind === 'reaction-state') {
    return `${operation.kind}|${operation.channelId}|${operation.targetId}|${(operation.payload as ReactionStatePayload).emoji}`;
  }
  return `${operation.kind}|${operation.channelId}|${operation.targetId}`;
}

export class EncryptedOperationLog {
  constructor(
    readonly userId: string,
    private readonly store: EncryptedLocalStore,
  ) {
    required(userId, 'userId');
  }

  private async all(): Promise<LocalOperation[]> {
    const rows = await this.store.list<LocalOperation>('oplog');
    return rows
      .map(row => normalizeOperation(row.value))
      .filter(row => row.userId === this.userId)
      .sort((a, b) => a.createdAt - b.createdAt || a.opId.localeCompare(b.opId));
  }

  async get(opId: string): Promise<LocalOperation | null> {
    const raw = await this.store.getJson<LocalOperation>('oplog', required(opId, 'opId', 128));
    if (!raw) return null;
    const normalized = normalizeOperation(raw);
    if (normalized.userId !== this.userId) throw new Error('Operation account mismatch');
    return normalized;
  }

  async listActive(): Promise<LocalOperation[]> {
    return (await this.all()).filter(row => ACTIVE_STATES.has(row.state));
  }

  async listAll(): Promise<LocalOperation[]> {
    return this.all();
  }

  async compact(now = Date.now()): Promise<void> {
    const rows = await this.all();
    const terminal = rows
      .filter(row => TERMINAL_STATES.has(row.state))
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const keepTerminal = new Set(
      terminal
        .filter(row => now - row.updatedAt <= LOCAL_OPLOG_TERMINAL_RETENTION_MS)
        .slice(0, Math.max(0, LOCAL_OPLOG_MAX_TOTAL - rows.filter(row => ACTIVE_STATES.has(row.state)).length))
        .map(row => row.opId),
    );

    for (const row of terminal) {
      if (!keepTerminal.has(row.opId)) await this.store.delete('oplog', row.opId);
    }
  }

  async enqueue(input: NewLocalOperation, now = Date.now()): Promise<LocalOperation> {
    if (input.userId !== this.userId) throw new Error('Operation account mismatch');
    await this.compact(now);

    const active = await this.listActive();
    const existing = await this.get(input.opId);
    const candidate: LocalOperation = normalizeOperation({
      v: LOCAL_OPLOG_VERSION,
      opId: input.opId,
      userId: input.userId,
      channelId: input.channelId,
      targetId: input.targetId,
      kind: input.kind,
      state: 'queued',
      payload: input.payload,
      createdAt: input.createdAt ?? now,
      updatedAt: now,
      attempts: 0,
    });

    if (existing) {
      if (!sameIdentityAndPayload(existing, candidate)) {
        throw new Error('Operation id collision');
      }
      return existing;
    }

    if (active.length >= LOCAL_OPLOG_MAX_ACTIVE) {
      throw new Error('Local-first operation log is full');
    }

    // Desired-state operations collapse only queued predecessors. Rejected is
    // terminal evidence; a user retry gets a fresh operation id. A sending
    // mutation stays visible until the server resolves it.
    const key = desiredKey(candidate);
    for (const previous of active) {
      if (
        previous.opId !== candidate.opId
        && desiredKey(previous) === key
        && previous.state === 'queued'
      ) {
        await this.transition(previous.opId, 'superseded', {
          supersededBy: candidate.opId,
        }, now);
      }
    }

    await this.store.putJson('oplog', candidate.opId, candidate, now);
    return candidate;
  }

  async transition(
    opId: string,
    state: LocalOperationState,
    patch: {
      lastError?: string;
      supersededBy?: string;
      incrementAttempts?: boolean;
    } = {},
    now = Date.now(),
  ): Promise<LocalOperation> {
    const current = await this.get(opId);
    if (!current) throw new Error('Operation not found');
    if (!transitionAllowed(current.state, state)) {
      throw new Error(`Invalid operation transition: ${current.state} -> ${state}`);
    }

    const next = normalizeOperation({
      ...current,
      state,
      updatedAt: Math.max(now, current.updatedAt),
      attempts: current.attempts + (patch.incrementAttempts ? 1 : 0),
      ...(patch.lastError !== undefined
        ? { lastError: String(patch.lastError).slice(0, 500) }
        : state === 'applied'
          ? { lastError: undefined }
          : {}),
      ...(patch.supersededBy ? { supersededBy: patch.supersededBy } : {}),
    });

    await this.store.putJson('oplog', next.opId, next, next.updatedAt);
    return next;
  }

  async removeTerminal(opId: string): Promise<void> {
    const current = await this.get(opId);
    if (!current) return;
    if (!TERMINAL_STATES.has(current.state)) {
      throw new Error('Active operation cannot be discarded');
    }
    await this.store.delete('oplog', opId);
  }
}
