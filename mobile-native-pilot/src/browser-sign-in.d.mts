import type { PkceAttempt } from './pkce.mjs';

export type BrowserSignInCode =
  | 'INVALID_ORIGIN' | 'INVALID_ADAPTER' | 'BROWSER_FAILED' | 'SUPERSEDED'
  | 'CANCELLED' | 'BAD_CALLBACK' | 'STATE_MISMATCH' | 'DENIED' | 'PKCE_FAILED';

export declare class BrowserSignInError extends Error {
  readonly code: BrowserSignInCode;
  constructor(code: BrowserSignInCode);
}

export type AuthSessionResult = { type: string; url?: string };

export interface BrowserSignIn {
  start(options?: { freshAuthentication?: boolean }): Promise<{ code: string; verifier: string; redirectUri: string }>;
  hasPendingAttempt(): boolean;
}

export declare function createBrowserSignIn(config: {
  origin: string;
  redirectUri: string;
  openAuthSession: (url: string, redirectUri: string) => Promise<AuthSessionResult>;
  createPkce: () => Promise<PkceAttempt>;
}): BrowserSignIn;
