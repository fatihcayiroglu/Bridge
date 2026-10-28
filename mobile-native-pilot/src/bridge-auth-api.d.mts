// Experimental sign-in adapter for the RN pilot (see bridge-auth-api.mjs for its boundary:
// no refresh token reaches a native client under the current server contract).
export type BridgeAuthCode =
  | 'INVALID_ORIGIN'
  | 'INVALID_ADAPTER'
  | 'INVALID_INPUT'
  | 'ABORTED'
  | 'NETWORK_FAILURE'
  | 'BAD_RESPONSE'
  | 'CAPTCHA_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'EMAIL_NOT_VERIFIED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'SERVER_UNAVAILABLE'
  | 'REQUEST_REJECTED';

export declare class BridgeAuthError extends Error {
  readonly code: BridgeAuthCode;
  constructor(code: BridgeAuthCode);
}

export type IssuedSession = { kind: 'session'; token: string; userId: string; displayName: string };
export type TwoFactorChallenge = { kind: 'two-factor'; challenge: string };
export type AuthOptions = { signal?: AbortSignal };

export interface BridgeAuthApi {
  signInWithPassword(username: string, password: string, options?: AuthOptions): Promise<IssuedSession | TwoFactorChallenge>;
  completeTwoFactor(challenge: string, code: string, options?: AuthOptions): Promise<IssuedSession>;
  logout(options?: AuthOptions): Promise<void>;
}

export declare function createBridgeAuthApi(config: {
  origin: string;
  fetchImpl?: typeof fetch;
}): BridgeAuthApi;
