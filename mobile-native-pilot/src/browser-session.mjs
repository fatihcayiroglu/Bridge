// Browser -> token exchange -> adoption. Kept separate from Expo's native
// adapters so the production orchestration can be exercised with the real
// session coordinator in deterministic race tests and real-backend tests.
import { SessionError } from './session-coordinator.mjs';

export function createBrowserSessionSignIn({ browser, authApi, coordinator }) {
  let generation = 0;
  return async function signInWithBrowser(options) {
    // Reserve the request before the browser's first asynchronous operation.
    const mine = ++generation;
    const admitted = coordinator.getState();
    const current = () => {
      const now = coordinator.getState();
      // Rejection/storage-failure can end trust within an existing epoch too.
      return generation === mine && now.epoch === admitted.epoch && now.phase === admitted.phase;
    };
    const callback = await browser.start(options);
    if (!current()) throw new SessionError('SUPERSEDED');
    const issued = await authApi.exchangeCode(callback);
    if (!current()) {
      // The server issued a credential, but this request no longer owns the
      // session. Never write it locally or clear the newer account's storage.
      try { await authApi.revoke(issued.refreshToken); } catch { /* best effort; never adopt */ }
      throw new SessionError('SUPERSEDED');
    }
    // No await between the fence and signIn's synchronous epoch transition.
    return coordinator.signIn(issued);
  };
}
