// Session lifecycle for the RN pilot: the single owner of "who is signed in".
// It joins the native credential port (Keychain/Keystore), the native token
// endpoints (code exchange, rotating refresh, revocation) and the read API.
//
// Credentials
// - The REFRESH token is the only persisted secret (credential port). The access
//   token lives in memory only and is exposed through getSession() solely while
//   the session is authenticated.
// - Every refresh rotates. The successor is persisted BEFORE it is used; a
//   successor that cannot be persisted, or that arrives for a superseded session,
//   is revoked server-side (best effort) and never adopted.
// - There is no grace window: if the app dies, or the response is lost, after the
//   server rotated, the stored token is consumed. Presenting it is reuse; the
//   server revokes the family and the user signs in again. Replay protection is
//   never weakened to avoid that sign-in.
//
// Invariants (each is a test in tests/session-coordinator.test.mjs):
// - A stored credential is never trusted until the server rotates it and
//   GET /api/me names the account; until then getSession() returns null.
// - Every account transition increments a monotonic epoch and clears memory at
//   the call site, before any await. A request or refresh started for one session
//   cannot be answered into the next (the read API fences on {token, epoch}).
// - Refresh is single-flight per session: concurrent 401s share one rotation; a
//   401 for an access token that was already replaced does not rotate again.
// - Native storage operations run in call order (the port serialises them); a
//   newer transition's storage operation is always queued after an older one.
// - Storage failures fail closed. invalid_grant ends the session and clears it.
// - Sign-out clears locally first, then revokes server-side, and reports honestly
//   whether the server confirmed it ('confirmed' | 'unconfirmed').
// - Emitted state never contains a token. Nothing here logs.

export class SessionError extends Error {
  constructor(code) {
    super(code);
    this.name = 'SessionError';
    this.code = code;
  }
}

const PHASES = Object.freeze({
  IDLE: 'idle',                     // not started
  RESTORING: 'restoring',           // reading / rotating / validating a stored credential, or persisting a sign-in
  SIGNED_OUT: 'signed-out',
  AUTHENTICATED: 'authenticated',   // server-validated session; access token in memory
  UNVERIFIED: 'unverified',         // stored credential could not be checked (offline); nothing trusted
  STORAGE_FAILED: 'storage-failed', // native storage refused; nothing trusted
});
export const SESSION_PHASES = PHASES;

// GET /api/me answers meaning "this account/session is not usable".
const ME_REJECTED = new Set(['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND', 'REQUEST_REJECTED']);

function validUserId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200;
}
function validSecret(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max;
}

/**
 * @param credentials   NativeCredentialPort (readToken/writeToken/clearToken), holds the refresh token
 * @param authApi       { refresh(refreshToken), revoke(refreshToken) } (native-auth-api)
 * @param createReadApi (getSession) => { getMe() }; used to name the account of a restored session
 */
export function createSessionCoordinator({ credentials, authApi, createReadApi }) {
  if (!credentials || typeof credentials.readToken !== 'function' ||
      typeof credentials.writeToken !== 'function' || typeof credentials.clearToken !== 'function' ||
      !authApi || typeof authApi.refresh !== 'function' || typeof authApi.revoke !== 'function' ||
      typeof createReadApi !== 'function') {
    throw new SessionError('INVALID_COORDINATOR');
  }

  let epoch = 0;
  let phase = PHASES.IDLE;
  let accessToken = null;   // memory only
  let refreshToken = null;  // memory copy of the persisted credential; never emitted
  let userId = null;
  let reason = null;
  let serverSignOut = null; // null | 'pending' | 'confirmed' | 'unconfirmed'
  let flight = null;        // { epoch, promise } single-flight refresh
  const listeners = new Set();

  function snapshot() {
    return Object.freeze({ phase, epoch, userId, reason, serverSignOut });
  }
  function emit() {
    const state = snapshot();
    for (const listener of [...listeners]) {
      try { listener(state); } catch { /* a listener cannot break the lifecycle */ }
    }
  }
  /** Starts a transition: everything decided under an older epoch is now stale. */
  function begin(nextPhase, nextReason = null) {
    epoch += 1;
    accessToken = null;
    refreshToken = null;
    userId = null;
    flight = null;
    phase = nextPhase;
    reason = nextReason;
    serverSignOut = null;
    return epoch;
  }
  const current = (mine) => mine === epoch;

  /** Best-effort server revocation of a credential this client will not use. */
  function discard(token) {
    if (!token) return;
    Promise.resolve().then(() => authApi.revoke(token)).catch(() => {});
  }

  function failStorage(mine, why) {
    if (!current(mine)) return;
    accessToken = null; refreshToken = null; userId = null; flight = null;
    phase = PHASES.STORAGE_FAILED; reason = why;
    emit();
  }

  async function clearStored(mine) {
    try {
      await credentials.clearToken();
      return true;
    } catch {
      failStorage(mine, 'CLEAR_FAILED');
      return false;
    }
  }

  /**
   * Rotates `presented` and persists the successor.
   * → { ok, tokens } | { rejected, why } | { unknown, why } | { stale } | { storageFailed }
   */
  async function rotate(mine, presented) {
    let tokens;
    try {
      tokens = await authApi.refresh(presented);
    } catch (error) {
      if (!current(mine)) return { stale: true };
      if (error?.code === 'INVALID_GRANT') return { rejected: true, why: error.reason === 'reuse' ? 'SESSION_REUSED' : 'SESSION_REJECTED' };
      // OUTCOME_UNKNOWN / RATE_LIMITED / BAD_RESPONSE / NETWORK_FAILURE: the presented
      // token may or may not be consumed. It is kept; it is never retried here.
      return { unknown: true, why: typeof error?.code === 'string' ? error.code : 'OUTCOME_UNKNOWN' };
    }
    // The successor now exists server-side and the presented token is consumed.
    if (!current(mine)) { discard(tokens.refreshToken); return { stale: true }; }
    try {
      await credentials.writeToken(tokens.refreshToken);
    } catch {
      discard(tokens.refreshToken);
      failStorage(mine, 'WRITE_FAILED');
      // The stored (consumed) predecessor must not be presented again either.
      await clearStored(mine);
      return { storageFailed: true };
    }
    if (!current(mine)) {
      // Superseded while writing: the newer transition's own storage operation is
      // queued after ours, so storage ends in the newer state.
      discard(tokens.refreshToken);
      return { stale: true };
    }
    return { ok: true, tokens };
  }

  async function endLocally(mine, why) {
    if (!current(mine)) return;
    phase = PHASES.SIGNED_OUT; reason = why; accessToken = null; refreshToken = null; userId = null; flight = null;
    emit();
    await clearStored(mine);
  }

  async function restore() {
    const mine = begin(PHASES.RESTORING);
    emit();
    let stored;
    try {
      stored = await credentials.readToken();
    } catch (error) {
      if (!current(mine)) return snapshot();
      if (error?.code === 'INVALID_STORED_TOKEN') {
        await endLocally(mine, 'CORRUPT_CREDENTIAL');
        return snapshot();
      }
      failStorage(mine, 'READ_FAILED');
      return snapshot();
    }
    if (!current(mine)) return snapshot();
    if (stored === null) {
      phase = PHASES.SIGNED_OUT; reason = null; emit();
      return snapshot();
    }

    const outcome = await rotate(mine, stored);
    if (outcome.stale || outcome.storageFailed) return snapshot();
    if (outcome.rejected) { await endLocally(mine, outcome.why); return snapshot(); }
    if (outcome.unknown) {
      // Keep the credential (memory copy only, never exposed); trust nothing.
      refreshToken = stored;
      phase = PHASES.UNVERIFIED; reason = outcome.why; emit();
      return snapshot();
    }

    // Name the account with the fresh access token, in a private snapshot.
    const probe = Object.freeze({ token: outcome.tokens.accessToken, epoch: mine });
    const api = createReadApi(() => (current(mine) ? probe : null));
    let me;
    try {
      me = await api.getMe();
    } catch (error) {
      if (!current(mine)) return snapshot();
      if (ME_REJECTED.has(error?.code)) {
        discard(outcome.tokens.refreshToken);
        await endLocally(mine, error.code === 'NOT_FOUND' ? 'ACCOUNT_GONE' : 'SESSION_REJECTED');
        return snapshot();
      }
      refreshToken = outcome.tokens.refreshToken;
      phase = PHASES.UNVERIFIED; reason = typeof error?.code === 'string' ? error.code : 'BAD_RESPONSE'; emit();
      return snapshot();
    }
    if (!current(mine)) return snapshot();
    if (!me || !validUserId(me.id)) {
      refreshToken = outcome.tokens.refreshToken;
      phase = PHASES.UNVERIFIED; reason = 'BAD_RESPONSE'; emit();
      return snapshot();
    }
    accessToken = outcome.tokens.accessToken;
    refreshToken = outcome.tokens.refreshToken;
    userId = me.id;
    phase = PHASES.AUTHENTICATED; reason = null;
    emit();
    return snapshot();
  }

  /** Adopts the tokens of a completed code exchange (native-auth-api exchangeCode). */
  async function signIn(issued) {
    if (!issued || !validSecret(issued.accessToken, 8192) || !validSecret(issued.refreshToken, 512) || !validUserId(issued.userId)) {
      throw new SessionError('INVALID_SESSION');
    }
    const previousUser = userId;
    const mine = begin(PHASES.RESTORING); // not usable until it is persisted
    emit();
    try {
      await credentials.writeToken(issued.refreshToken);
    } catch {
      discard(issued.refreshToken);
      if (current(mine)) {
        failStorage(mine, 'WRITE_FAILED');
        await clearStored(mine);
      }
      throw new SessionError('STORAGE_FAILED');
    }
    if (!current(mine)) {
      discard(issued.refreshToken);
      throw new SessionError('SUPERSEDED');
    }
    accessToken = issued.accessToken;
    refreshToken = issued.refreshToken;
    userId = issued.userId;
    phase = PHASES.AUTHENTICATED;
    reason = previousUser && previousUser !== issued.userId ? 'ACCOUNT_SWITCHED' : null;
    emit();
    return snapshot();
  }

  /**
   * A request answered 401 with `failed` = the {token, epoch} snapshot it used.
   * Resolves to a fresh session snapshot, or null when the session ended or a
   * refresh is not possible now. Concurrent callers share one rotation.
   */
  function refreshAfterUnauthorized(failed) {
    if (!failed || failed.epoch !== epoch || phase !== PHASES.AUTHENTICATED) return Promise.resolve(null);
    // The access token that failed was already replaced: no second rotation.
    if (failed.token !== accessToken) return Promise.resolve(accessToken ? { token: accessToken, epoch } : null);
    if (flight && flight.epoch === epoch) return flight.promise;

    const mine = epoch;
    const presented = refreshToken;
    const promise = (async () => {
      const outcome = await rotate(mine, presented);
      if (flight?.promise === promise) flight = null;
      if (outcome.ok) {
        accessToken = outcome.tokens.accessToken;
        refreshToken = outcome.tokens.refreshToken;
        emit();
        return { token: accessToken, epoch };
      }
      if (outcome.rejected) await endLocally(mine, outcome.why);
      return null;
    })();
    flight = { epoch: mine, promise };
    return promise;
  }

  async function endSession(nextReason) {
    const presented = refreshToken;
    const mine = begin(PHASES.SIGNED_OUT, nextReason);
    // The local clear is queued before anything else can be.
    const cleared = clearStored(mine);
    serverSignOut = presented ? 'pending' : null;
    emit();
    await cleared;
    if (!presented) return snapshot();
    let confirmed = false;
    try { await authApi.revoke(presented); confirmed = true; } catch { confirmed = false; }
    if (current(mine)) {
      serverSignOut = confirmed ? 'confirmed' : 'unconfirmed';
      emit();
    }
    return snapshot();
  }

  return Object.freeze({
    /** Read-API snapshot: only a server-validated session is ever exposed. */
    getSession() {
      return phase === PHASES.AUTHENTICATED && accessToken ? { token: accessToken, epoch } : null;
    },
    getState: snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new SessionError('INVALID_LISTENER');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    restore,
    signIn,
    refreshAfterUnauthorized,
    signOut: () => endSession('SIGNED_OUT'),
    /** After the server confirmed the account deletion. */
    accountDeleted: () => endSession('ACCOUNT_DELETED'),
  });
}
