export type NativeAuthCode =
  | 'INVALID_ORIGIN' | 'INVALID_ADAPTER' | 'INVALID_INPUT'
  | 'NETWORK_FAILURE' | 'OUTCOME_UNKNOWN' | 'BAD_RESPONSE'
  | 'INVALID_GRANT' | 'INVALID_REQUEST' | 'RATE_LIMITED' | 'SERVER_UNAVAILABLE';
export type InvalidGrantReason = 'reuse' | 'expired' | 'revoked' | 'not_found' | 'user_not_found';

export declare class NativeAuthError extends Error {
  readonly code: NativeAuthCode;
  /** Only for INVALID_GRANT, when the server named a known reason. */
  readonly reason: InvalidGrantReason | null;
  constructor(code: NativeAuthCode, reason?: InvalidGrantReason | null);
}

export type NativeTokens = { accessToken: string; refreshToken: string; expiresIn: number | null };
export type ExchangedSession = NativeTokens & { userId: string };

export interface NativeAuthApi {
  exchangeCode(input: { code: string; verifier: string; redirectUri: string }): Promise<ExchangedSession>;
  /** Rotates. OUTCOME_UNKNOWN means the presented token may already be consumed. */
  refresh(refreshToken: string): Promise<NativeTokens>;
  /** POST /api/refresh/logout with a body refreshToken. */
  revoke(refreshToken: string): Promise<void>;
}

export declare function createNativeAuthApi(config: {
  origin: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): NativeAuthApi;
