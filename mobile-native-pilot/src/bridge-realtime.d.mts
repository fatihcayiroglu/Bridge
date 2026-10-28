import type { SessionCoordinator } from './session-coordinator.mjs';

export type RealtimeCode =
  | 'INVALID_ORIGIN' | 'INVALID_ADAPTER' | 'INVALID_ID' | 'INVALID_CONTENT' | 'NOT_JOINED'
  | 'IDEMPOTENCY_CONFLICT' | 'IDEMPOTENCY_CAPACITY';

export declare class RealtimeError extends Error {
  readonly code: RealtimeCode;
  constructor(code: RealtimeCode);
}

export type RealtimeStatus = 'offline' | 'connecting' | 'online' | 'auth-failed';
export type ChannelMessage = { _id: string; channelId: string; content: string; userId: string; displayName: string; createdAt: number };
export type SendResult =
  | { status: 'confirmed'; messageId: string }
  | { status: 'failed'; code: string }
  | { status: 'unconfirmed'; reason: 'OFFLINE' | 'NO_ECHO' | 'SESSION_ENDED' };

export interface BridgeRealtime {
  start(): void;
  stop(): void;
  dispose(): void;
  getStatus(): RealtimeStatus;
  onStatus(listener: (status: RealtimeStatus) => void): () => void;
  onMessage(listener: (message: ChannelMessage) => void): () => void;
  joinChannel(channelId: string): void;
  /** Never resends internally. Outbox retries must retain the original ackId. */
  send(input: { serverId: string; channelId: string; content: string; ackId?: string }): Promise<SendResult>;
}

export declare function createBridgeRealtime(config: {
  origin: string;
  coordinator: Pick<SessionCoordinator, 'getSession' | 'getState' | 'subscribe' | 'refreshAfterUnauthorized'>;
  connect: (origin: string, options: Record<string, unknown>) => unknown;
  confirmTimeoutMs?: number;
}): BridgeRealtime;
