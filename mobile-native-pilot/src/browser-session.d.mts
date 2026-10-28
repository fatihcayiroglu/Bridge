import type { BrowserSignIn } from './browser-sign-in.mjs';
import type { NativeAuthApi } from './native-auth-api.mjs';
import type { SessionCoordinator, SessionState } from './session-coordinator.mjs';

/** Refuses superseded browser/exchange results and best-effort revokes orphans. */
export declare function createBrowserSessionSignIn(config: {
  browser: Pick<BrowserSignIn, 'start'>;
  authApi: Pick<NativeAuthApi, 'exchangeCode' | 'revoke'>;
  coordinator: Pick<SessionCoordinator, 'getState' | 'signIn'>;
}): () => Promise<SessionState>;
