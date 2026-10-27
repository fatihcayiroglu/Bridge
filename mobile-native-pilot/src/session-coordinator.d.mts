import type { BridgeReadApi, SessionSnapshot } from './bridge-read-api.mjs';
import type { NativeCredentialPort } from './native-credential-port.mjs';
import type { IssuedSession } from './bridge-auth-api.mjs';

export type SessionErrorCode =
  | 'INVALID_COORDINATOR'
  | 'INVALID_SESSION'
  | 'INVALID_LISTENER'
  | 'STORAGE_FAILED'
  | 'SUPERSEDED';

export declare class SessionError extends Error {
  readonly code: SessionErrorCode;
  constructor(code: SessionErrorCode);
}

export type SessionPhase =
  | 'idle' | 'restoring' | 'signed-out' | 'authenticated' | 'unverified' | 'storage-failed';

export declare const SESSION_PHASES: Readonly<{
  IDLE: 'idle'; RESTORING: 'restoring'; SIGNED_OUT: 'signed-out';
  AUTHENTICATED: 'authenticated'; UNVERIFIED: 'unverified'; STORAGE_FAILED: 'storage-failed';
}>;

/** Never contains a token. `reason` explains the last transition when it matters. */
export type SessionState = Readonly<{
  phase: SessionPhase;
  epoch: number;
  userId: string | null;
  reason: string | null;
}>;

export interface SessionCoordinator {
  getSession(): SessionSnapshot;
  getState(): SessionState;
  subscribe(listener: (state: SessionState) => void): () => void;
  restore(): Promise<SessionState>;
  signIn(issued: IssuedSession): Promise<SessionState>;
  signOut(): Promise<SessionState>;
  accountDeleted(): Promise<SessionState>;
  /**
   * For a request that the server refused because the SESSION is invalid (401, or a
   * 403 account refusal). A 403 STEP_UP_REQUIRED is not a session failure; do not pass it.
   */
  reportAuthFailure(failedEpoch: number | string): Promise<SessionState>;
}

export declare function createSessionCoordinator(config: {
  credentials: NativeCredentialPort;
  createReadApi: (getSession: () => SessionSnapshot) => Pick<BridgeReadApi, 'getMe'>;
  serverLogout?: (() => Promise<void>) | null;
}): SessionCoordinator;
