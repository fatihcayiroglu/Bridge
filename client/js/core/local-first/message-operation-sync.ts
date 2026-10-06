// P7 A5 — single replay owner for durable non-send message operations.
//
// Message SEND stays owned by MessageInputPanel's canonical encrypted outbox and
// ackId protocol. This owner handles only edit/delete/reaction operations from
// the encrypted operation log, so there is exactly one replay path per class.

import { BridgeRegistry } from '../bridge-registry.ts';
import { createLogger } from '../logger.ts';
import {
  closeLocalFirstOperationRuntime,
  compactLocalFirstOperations,
  enqueueLocalFirstOperation,
  getLocalFirstOperation,
  listActiveLocalFirstOperations,
  resetLocalFirstOperationRuntimeForTests,
  transitionLocalFirstOperation,
} from './operation-runtime.ts';
import type {
  EditMessagePayload,
  LocalOperation,
  NewLocalOperation,
  ReactionStatePayload,
} from './operation-log.ts';

const log = createLogger('MessageOperationSync');
export const MESSAGE_OPERATION_ACK_TIMEOUT_MS = 10_000;

interface SocketLike {
  emit(event: string, payload: Record<string, unknown>): void;
}

export interface QueuedMessageOperation {
  opId: string;
  dispatched: boolean;
}

interface QueueEditInput {
  channelId: string;
  messageId: string;
  content: string;
  baseVersion: number;
}

interface QueueDeleteInput {
  channelId: string;
  messageId: string;
}

interface QueueReactionInput {
  channelId: string;
  messageId: string;
  emoji: string;
  desired: boolean;
}

const acknowledgementTimers = new Map<string, ReturnType<typeof setTimeout>>();
const operationUsers = new Map<string, string>();
let replayPromise: Promise<void> | null = null;
let lastUserId = '';
let generation = 0;

function currentUserId(): string | null {
  const me = BridgeRegistry.call<{ _id?: string; id?: string } | null>('getMe');
  const userId = String(me?._id ?? me?.id ?? '').trim();
  if (userId) lastUserId = userId;
  return userId || null;
}

function currentSocket(): SocketLike | null {
  return BridgeRegistry.get<SocketLike>('socket') ?? null;
}

function socketConnected(socket: SocketLike | null): boolean {
  if (!socket) return false;
  return BridgeRegistry.call<boolean>('getSocketConnected') ?? true;
}

function newOperationId(): string {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === 'function') return cryptoObject.randomUUID();
  return 'op-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}

function required(value: string, label: string): string {
  const normalized = String(value ?? '').trim();
  if (!normalized) throw new Error(label + ' is required');
  return normalized;
}

function operationKey(operation: LocalOperation): string {
  if (operation.kind === 'reaction-state') {
    return 'reaction|' + operation.channelId + '|' + operation.targetId + '|'
      + (operation.payload as ReactionStatePayload).emoji;
  }
  return operation.kind + '|' + operation.channelId + '|' + operation.targetId;
}

function dispatchLifecycle(
  name: 'bridge:message-operation-dispatched'
    | 'bridge:message-operation-timeout'
    | 'bridge:message-operation-applied'
    | 'bridge:message-operation-rejected'
    | 'bridge:message-operation-queued',
  operation: LocalOperation,
  detail: Record<string, unknown> = {},
): void {
  if (typeof document === 'undefined') return;
  document.dispatchEvent(new CustomEvent(name, {
    detail: {
      opId: operation.opId,
      kind: operation.kind,
      channelId: operation.channelId,
      targetId: operation.targetId,
      ...detail,
    },
  }));
}

function clearAcknowledgementTimer(opId: string): void {
  const timer = acknowledgementTimers.get(opId);
  if (timer) clearTimeout(timer);
  acknowledgementTimers.delete(opId);
}

function armAcknowledgementTimer(userId: string, operation: LocalOperation): void {
  clearAcknowledgementTimer(operation.opId);
  const expectedGeneration = generation;
  const timer = setTimeout(() => {
    acknowledgementTimers.delete(operation.opId);
    if (expectedGeneration !== generation) return;

    void transitionLocalFirstOperation(userId, operation.opId, 'sending', {
      lastError: 'ack-timeout',
    })
      .then(updated => {
        dispatchLifecycle('bridge:message-operation-timeout', updated);
      })
      .catch(error => log.warn('Mutation ACK timeout kaydedilemedi', error));
  }, MESSAGE_OPERATION_ACK_TIMEOUT_MS);
  acknowledgementTimers.set(operation.opId, timer);
}

function emitOperation(socket: SocketLike, operation: LocalOperation): void {
  if (operation.kind === 'edit-message') {
    const payload = operation.payload as EditMessagePayload;
    socket.emit('message:edit', {
      messageId: operation.targetId,
      channelId: operation.channelId,
      content: payload.content,
      clientNonce: operation.opId,
      baseVersion: payload.baseVersion,
    });
    return;
  }

  if (operation.kind === 'delete-message') {
    socket.emit('message:delete', {
      messageId: operation.targetId,
      channelId: operation.channelId,
      clientNonce: operation.opId,
    });
    return;
  }

  const payload = operation.payload as ReactionStatePayload;
  socket.emit('message:react', {
    messageId: operation.targetId,
    channelId: operation.channelId,
    emoji: payload.emoji,
    active: payload.desired,
    clientNonce: operation.opId,
  });
}

async function dispatchQueuedOperation(
  userId: string,
  operation: LocalOperation,
  expectedGeneration: number,
): Promise<boolean> {
  if (expectedGeneration !== generation || operation.state !== 'queued') return false;
  const socket = currentSocket();
  if (!socketConnected(socket) || !socket) return false;

  let sending: LocalOperation;
  try {
    sending = await transitionLocalFirstOperation(userId, operation.opId, 'sending', {
      incrementAttempts: true,
      lastError: '',
    });
  } catch (error) {
    log.warn('Mutation sending durumuna geçirilemedi', error);
    return false;
  }

  if (expectedGeneration !== generation) {
    await transitionLocalFirstOperation(userId, operation.opId, 'queued', {
      lastError: 'session-changed',
    }).catch(() => undefined);
    return false;
  }

  const latestSocket = currentSocket();
  if (!socketConnected(latestSocket) || !latestSocket) {
    const queued = await transitionLocalFirstOperation(userId, operation.opId, 'queued', {
      lastError: 'disconnected-before-emit',
    }).catch(() => null);
    if (queued) dispatchLifecycle('bridge:message-operation-queued', queued);
    return false;
  }

  try {
    emitOperation(latestSocket, sending);
  } catch (error) {
    const queued = await transitionLocalFirstOperation(userId, operation.opId, 'queued', {
      lastError: 'socket-emit-failed',
    }).catch(() => null);
    if (queued) dispatchLifecycle('bridge:message-operation-queued', queued);
    log.warn('Mutation socket emit başarısız', error);
    return false;
  }

  operationUsers.set(operation.opId, userId);
  armAcknowledgementTimer(userId, sending);
  dispatchLifecycle('bridge:message-operation-dispatched', sending);
  return true;
}

async function runReplay(recoverSending: boolean, expectedGeneration: number): Promise<void> {
  const userId = currentUserId();
  const socket = currentSocket();
  if (!userId || !socketConnected(socket) || expectedGeneration !== generation) return;

  let active = await listActiveLocalFirstOperations(userId);
  if (expectedGeneration !== generation) return;

  if (recoverSending) {
    for (const operation of active) {
      if (operation.state !== 'sending') continue;
      clearAcknowledgementTimer(operation.opId);
      const queued = await transitionLocalFirstOperation(userId, operation.opId, 'queued', {
        lastError: 'connection-recovered',
      }).catch(error => {
        log.warn('Uçuşta mutation tekrar kuyruğa alınamadı', error);
        return null;
      });
      if (queued) dispatchLifecycle('bridge:message-operation-queued', queued);
    }
    active = await listActiveLocalFirstOperations(userId);
  }

  const busyKeys = new Set(
    active.filter(operation => operation.state === 'sending').map(operationKey),
  );

  for (const operation of active) {
    if (expectedGeneration !== generation) return;
    if (operation.state !== 'queued') continue;
    const key = operationKey(operation);
    if (busyKeys.has(key)) continue;
    if (await dispatchQueuedOperation(userId, operation, expectedGeneration)) {
      busyKeys.add(key);
    }
  }
}

/**
 * Replays the encrypted non-send operation log.
 *
 * recoverSending=true is used on a fresh/reconnected socket: a process crash
 * or lost connection may have persisted "sending" without receiving its ACK.
 * Desired-state server semantics make replay safe.
 */
export function replayMessageOperations(recoverSending = false): Promise<void> {
  if (replayPromise) return replayPromise;
  const expectedGeneration = generation;
  replayPromise = runReplay(recoverSending, expectedGeneration)
    .finally(() => { replayPromise = null; });
  return replayPromise;
}

async function queueOperation(input: Omit<NewLocalOperation, 'userId' | 'opId'>): Promise<QueuedMessageOperation> {
  const userId = currentUserId();
  if (!userId) throw new Error('Operation userId is unavailable');

  const opId = newOperationId();
  const operation = await enqueueLocalFirstOperation({
    ...input,
    opId,
    userId,
  });
  operationUsers.set(opId, userId);

  // A replay may already be walking an older snapshot. Run once, inspect our
  // row, then run again if necessary so a just-enqueued row is not stranded.
  await replayMessageOperations(false);
  let current = await getLocalFirstOperation(userId, opId);
  if (current?.state === 'queued' && socketConnected(currentSocket())) {
    await replayMessageOperations(false);
    current = await getLocalFirstOperation(userId, opId);
  }

  return { opId, dispatched: current?.state === 'sending' };
}

export function queueEditMessageOperation(input: QueueEditInput): Promise<QueuedMessageOperation> {
  const baseVersion = Number(input.baseVersion);
  if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
    return Promise.reject(new Error('Edit baseVersion is required for durable replay'));
  }
  return queueOperation({
    channelId: required(input.channelId, 'channelId'),
    targetId: required(input.messageId, 'messageId'),
    kind: 'edit-message',
    payload: {
      content: String(input.content ?? ''),
      baseVersion,
    },
  });
}

export function queueDeleteMessageOperation(input: QueueDeleteInput): Promise<QueuedMessageOperation> {
  return queueOperation({
    channelId: required(input.channelId, 'channelId'),
    targetId: required(input.messageId, 'messageId'),
    kind: 'delete-message',
    payload: {},
  });
}

export function queueReactionMessageOperation(input: QueueReactionInput): Promise<QueuedMessageOperation> {
  return queueOperation({
    channelId: required(input.channelId, 'channelId'),
    targetId: required(input.messageId, 'messageId'),
    kind: 'reaction-state',
    payload: {
      emoji: String(input.emoji ?? ''),
      desired: input.desired,
    },
  });
}

function operationUser(opId: string): string | null {
  return operationUsers.get(opId) ?? currentUserId() ?? (lastUserId || null);
}

export async function resolveMessageOperation(opIdInput: string): Promise<void> {
  const opId = String(opIdInput ?? '').trim();
  if (!opId) return;
  const userId = operationUser(opId);
  if (!userId) return;

  clearAcknowledgementTimer(opId);
  const current = await getLocalFirstOperation(userId, opId).catch(() => null);
  if (!current || current.state === 'applied' || current.state === 'rejected' || current.state === 'superseded') return;

  const applied = await transitionLocalFirstOperation(userId, opId, 'applied').catch(error => {
    log.warn('Mutation applied olarak kaydedilemedi', error);
    return null;
  });
  if (!applied) return;

  dispatchLifecycle('bridge:message-operation-applied', applied);
  void compactLocalFirstOperations(userId).catch(() => undefined);
  void replayMessageOperations(false);
}

export async function rejectMessageOperation(opIdInput: string, code?: string): Promise<void> {
  const opId = String(opIdInput ?? '').trim();
  if (!opId) return;
  const userId = operationUser(opId);
  if (!userId) return;

  clearAcknowledgementTimer(opId);
  const current = await getLocalFirstOperation(userId, opId).catch(() => null);
  if (!current || current.state === 'applied' || current.state === 'rejected' || current.state === 'superseded') return;

  const rejected = await transitionLocalFirstOperation(userId, opId, 'rejected', {
    lastError: String(code ?? 'MUTATION_REJECTED'),
  }).catch(error => {
    log.warn('Mutation rejected olarak kaydedilemedi', error);
    return null;
  });
  if (!rejected) return;

  dispatchLifecycle('bridge:message-operation-rejected', rejected, {
    code: String(code ?? 'MUTATION_REJECTED'),
  });
  void compactLocalFirstOperations(userId).catch(() => undefined);
  void replayMessageOperations(false);
}

/** Socket loss makes every in-flight desired-state mutation replayable again. */
export async function handleMessageOperationSocketDisconnected(): Promise<void> {
  const userId = currentUserId() ?? (lastUserId || null);
  if (!userId) return;

  const active = await listActiveLocalFirstOperations(userId).catch(() => []);
  for (const operation of active) {
    if (operation.state !== 'sending') continue;
    clearAcknowledgementTimer(operation.opId);
    const queued = await transitionLocalFirstOperation(userId, operation.opId, 'queued', {
      lastError: 'socket-disconnected',
    }).catch(error => {
      log.warn('Disconnect mutation kuyruğuna yazılamadı', error);
      return null;
    });
    if (queued) dispatchLifecycle('bridge:message-operation-queued', queued);
  }
}

/** Releases only in-memory handles/timers; durable operations remain encrypted. */
export function closeMessageOperationSync(): void {
  generation += 1;
  for (const timer of acknowledgementTimers.values()) clearTimeout(timer);
  acknowledgementTimers.clear();
  operationUsers.clear();
  replayPromise = null;

  const userId = currentUserId() ?? (lastUserId || null);
  if (userId) closeLocalFirstOperationRuntime(userId);
  lastUserId = '';
}

export function resetMessageOperationSyncForTests(): void {
  generation += 1;
  for (const timer of acknowledgementTimers.values()) clearTimeout(timer);
  acknowledgementTimers.clear();
  operationUsers.clear();
  replayPromise = null;
  lastUserId = '';
  resetLocalFirstOperationRuntimeForTests();
}
