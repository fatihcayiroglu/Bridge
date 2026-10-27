// Session lifecycle for the RN pilot: the single owner of "who is signed in".
// It joins the native credential port (Keychain/Keystore) and the read-only API.
//
// Invariants (each is a test in tests/session-coordinator.test.mjs):
// - A stored token is never trusted until GET /api/me accepts it; until then
//   getSession() returns null, so no other request can use it.
// - Every transition increments a monotonic epoch. Memory is cleared at the
//   call site, before any await, so a request started for one session cannot
//   be answered into the next (the read API fences on {token, epoch}).
// - Native storage operations run in call order (the port serialises them) and
//   any operation decided by an older epoch is dropped when a newer transition
//   happened first: a slow restore can never erase or overwrite a newer sign-in.
// - A 401/403 counts only for the epoch that produced it; a late refusal from a
//   previous account cannot sign out the current one.
// - Storage failures fail closed: no session is reported that could not be
//   persisted, and a credential that could not be deleted is reported as such.
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
  RESTORING: 'restoring',           // reading/validating a stored credential
  SIGNED_OUT: 'signed-out',
  AUTHENTICATED: 'authenticated',   // server-validated (restore) or server-issued (sign-in)
  UNVERIFIED: 'unverified',         // stored credential could not be checked (offline); not trusted
  STORAGE_FAILED: 'storage-failed', // native storage refused; nothing is trusted
});
export const SESSION_PHASES = PHASES;

// Answers of GET /api/me that mean "this credential is no longer valid".
const REJECTED = new Set(['AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND', 'REQUEST_REJECTED']);
// Answers that say nothing about the credential (keep it, trust nothing).
const UNKNOWN = new Set(['NETWORK_FAILURE', 'SERVER_UNAVAILABLE', 'RATE_LIMITED', 'BAD_RESPONSE', 'ABORTED']);

function validToken(token) {
  return typeof token === 'string' && token.length > 0 && token.length <= 8192;
}
function validUserId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= 200;
}

/**
 * @param credentials  NativeCredentialPort (readToken/writeToken/clearToken)
 * @param createReadApi (getSession) => BridgeReadApi; used to validate a restored token
 * @param serverLogout optional () => Promise<void>; best effort, never blocks local sign-out
 */
export function createSessionCoordinator({ credentials, createReadApi, serverLogout = null }) {
  if (!credentials || typeof credentials.readToken !== 'function' ||
      typeof credentials.writeToken !== 'function' || typeof credentials.clearToken !== 'function' ||
      typeof createReadApi !== 'function' || (serverLogout !== null && typeof serverLogout !== 'function')) {
    throw new SessionError('INVALID_COORDINATOR');
  }

  let epoch = 0;
  let phase = PHASES.IDLE;
  let token = null;        // memory only; exposed through getSession() when authenticated
  let userId = null;
  let reason = null;
  const listeners = new Set();

  function snapshot() {
    return Object.freeze({ phase, epoch, userId, reason });
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
    token = null;
    userId = null;
    phase = nextPhase;
    reason = nextReason;
    return epoch;
  }
  const current = (mine) => mine === epoch;

  async function clearStored(mine, failurePhaseReason) {
    try {
      await credentials.clearToken();
      return true;
    } catch {
      if (current(mine)) {
        phase = PHASES.STORAGE_FAILED;
        reason = failurePhaseReason;
        emit();
      }
      return false;
    }
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
        // Corrupt slot: never usable. Remove it, unless a newer transition owns storage now.
        phase = PHASES.SIGNED_OUT; reason = 'CORRUPT_CREDENTIAL'; emit();
        await clearStored(mine, 'CLEAR_FAILED');
        return snapshot();
      }
      phase = PHASES.STORAGE_FAILED; reason = 'READ_FAILED'; emit();
      return snapshot();
    }
    if (!current(mine)) return snapshot();
    if (stored === null) {
      phase = PHASES.SIGNED_OUT; reason = null; emit();
      return snapshot();
    }

    // Validate with the stored token in a private snapshot: getSession() stays null.
    const probe = Object.freeze({ token: stored, epoch: mine });
    const api = createReadApi(() => (current(mine) ? probe : null));
    let me;
    try {
      me = await api.getMe();
    } catch (error) {
      if (!current(mine)) return snapshot();
      const code = error?.code;
      if (code === 'SESSION_CHANGED') return snapshot();
      if (REJECTED.has(code)) {
        phase = PHASES.SIGNED_OUT; reason = code === 'NOT_FOUND' ? 'ACCOUNT_GONE' : 'SESSION_REJECTED'; emit();
        await clearStored(mine, 'CLEAR_FAILED');
        return snapshot();
      }
      phase = PHASES.UNVERIFIED; reason = UNKNOWN.has(code) ? code : 'BAD_RESPONSE'; emit();
      return snapshot();
    }
    if (!current(mine)) return snapshot();
    if (!me || !validUserId(me.id)) {
      phase = PHASES.UNVERIFIED; reason = 'BAD_RESPONSE'; emit();
      return snapshot();
    }
    token = stored;
    userId = me.id;
    phase = PHASES.AUTHENTICATED;
    reason = null;
    emit();
    return snapshot();
  }

  /** Adopts a server-issued session (password or 2FA sign-in). */
  async function signIn(issued) {
    if (!issued || issued.kind !== 'session' || !validToken(issued.token) || !validUserId(issued.userId)) {
      throw new SessionError('INVALID_SESSION');
    }
    const previousUser = userId;
    const mine = begin(PHASES.RESTORING); // not usable until it is persisted
    emit();
    try {
      await credentials.writeToken(issued.token);
    } catch {
      if (current(mine)) {
        // Fail closed: a session that cannot be stored is not adopted, and any partial
        // write is removed.
        phase = PHASES.STORAGE_FAILED; reason = 'WRITE_FAILED'; emit();
        await clearStored(mine, 'WRITE_FAILED');
      }
      throw new SessionError('STORAGE_FAILED');
    }
    if (!current(mine)) {
      // Superseded while writing (sign-out or another sign-in came later). Their own
      // storage operation is queued after ours, so the newer state wins in storage too.
      throw new SessionError('SUPERSEDED');
    }
    token = issued.token;
    userId = issued.userId;
    phase = PHASES.AUTHENTICATED;
    reason = previousUser && previousUser !== issued.userId ? 'ACCOUNT_SWITCHED' : null;
    emit();
    return snapshot();
  }

  async function endSession(nextReason) {
    const mine = begin(PHASES.SIGNED_OUT, nextReason);
    emit();
    if (serverLogout) {
      // Not awaited before the local clear, and its failure changes nothing locally.
      Promise.resolve().then(serverLogout).catch(() => {});
    }
    await clearStored(mine, 'CLEAR_FAILED');
    return snapshot();
  }

  return Object.freeze({
    /** Read-API snapshot: only a validated or server-issued session is ever exposed. */
    getSession() {
      return phase === PHASES.AUTHENTICATED && token ? { token, epoch } : null;
    },
    getState: snapshot,
    subscribe(listener) {
      if (typeof listener !== 'function') throw new SessionError('INVALID_LISTENER');
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    restore,
    signIn,
    signOut: () => endSession('SIGNED_OUT'),
    /** After the server confirmed the account deletion. */
    accountDeleted: () => endSession('ACCOUNT_DELETED'),
    /**
     * A request answered 401/403. Only the session that sent it can be ended by it:
     * pass the epoch of the snapshot the request used.
     */
    reportAuthFailure(failedEpoch) {
      if (phase !== PHASES.AUTHENTICATED || failedEpoch !== epoch) return Promise.resolve(snapshot());
      return endSession('SESSION_REJECTED');
    },
  });
}
