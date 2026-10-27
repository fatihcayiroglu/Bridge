import type { BridgeReadApi, SessionSnapshot } from './bridge-read-api.mjs';
import type { NativeCredentialPort } from './native-credential-port.mjs';
import type { ExchangedSession, NativeAuthApi } from './native-auth-api.mjs';

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

/** Never contains a token. */
export type SessionState = Readonly<{
  phase: SessionPhase;
  epoch: number;
  userId: string | null;
  reason: string | null;
  /** After sign-out: whether the server confirmed the revocation. */
  serverSignOut: null | 'pending' | 'confirmed' | 'unconfirmed';
}>;

export interface SessionCoordinator {
  getSession(): SessionSnapshot;
  getState(): SessionState;
  subscribe(listener: (state: SessionState) => void): () => void;
  restore(): Promise<SessionState>;
  signIn(issued: Pick<ExchangedSession, 'accessToken' | 'refreshToken' | 'userId'>): Promise<SessionState>;
  /**
   * After a 401 for the snapshot `failed`. Shares one rotation between callers.
   * A 403 STEP_UP_REQUIRED is not a session failure; do not pass it.
   */
  refreshAfterUnauthorized(failed: NonNullable<SessionSnapshot>): Promise<SessionSnapshot>;
  signOut(): Promise<SessionState>;
  accountDeleted(): Promise<SessionState>;
}

export declare function createSessionCoordinator(config: {
  credentials: NativeCredentialPort;
  authApi: Pick<NativeAuthApi, 'refresh' | 'revoke'>;
  createReadApi: (getSession: () => SessionSnapshot) => Pick<BridgeReadApi, 'getMe'>;
}): SessionCoordinator;
