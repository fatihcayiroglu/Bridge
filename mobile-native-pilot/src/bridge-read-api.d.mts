// Experimental read-only Bridge HTTP adapter for a future React Native client.
// These types are not a production identity or token-storage contract.
export type BridgeReadCode =
  | 'INVALID_ORIGIN'
  | 'INVALID_ID'
  | 'INVALID_ADAPTER'
  | 'INVALID_LIMIT'
  | 'AUTH_REQUIRED'
  | 'SESSION_CHANGED'
  | 'ABORTED'
  | 'NETWORK_FAILURE'
  | 'BAD_RESPONSE'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'SERVER_UNAVAILABLE'
  | 'REQUEST_REJECTED';

export declare class BridgeReadError extends Error {
  readonly code: BridgeReadCode;
  constructor(code: BridgeReadCode);
}

// Caller MUST increment epoch on login, logout, or account switch.
// The adapter neither creates nor persists tokens.
export type SessionSnapshot = { token: string; epoch: string | number } | null;
export type ReadOptions = { signal?: AbortSignal };
export type MessageOptions = ReadOptions & { limit?: number };
export type ReadListItem = { id: string; name: string };
export type MessageRow = { _id: string; [key: string]: unknown };
export interface BridgeReadApi {
  getMe(options?: ReadOptions): Promise<{ id: string; displayName: string }>;
  listServers(options?: ReadOptions): Promise<ReadListItem[]>;
  listChannels(serverId: string, options?: ReadOptions): Promise<ReadListItem[]>;
  listMessages(channelId: string, options?: MessageOptions): Promise<{
    messages: MessageRow[];
    hasMore: boolean;
    nextCursor: string | null;
  }>;
}

export declare function createBridgeReadApi(config: {
  origin: string;
  getSession: () => SessionSnapshot | Promise<SessionSnapshot>;
  fetchImpl?: typeof fetch;
}): BridgeReadApi;
