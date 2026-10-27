// Fresh-install credential purge for the RN pilot (security review finding 5).
//
// iOS keeps Keychain items after the app is uninstalled; the app sandbox does not
// survive. So a refresh token found in the Keychain with NO sandbox marker belongs to
// an earlier installation: whoever installs the app again (the same person, or the next
// owner of the device) must not be signed in by it. Android needs no special case
// (Keystore data goes with the app), but the same rule holds there and costs nothing.
//
// Invariants:
// - No restore happens before prepare() resolves; a failure here means NO restore.
// - On a fresh install the leftover credential is deleted BEFORE the marker is written,
//   so a crash in between purges again on the next launch rather than restoring.
// - The leftover is revoked on the server best-effort; it is never presented to
//   /refresh (that would rotate it and sign the new installation in).
// - The marker holds a random installation id, nothing secret, and no account.
export class InstallGuardError extends Error {
  constructor(code) {
    super(code);
    this.name = 'InstallGuardError';
    this.code = code;
  }
}

const MARKER_RE = /^[A-Za-z0-9-]{16,64}$/;

/**
 * @param marker      { read(): Promise<string|null>, write(id): Promise<void> } in the app sandbox
 * @param credentials NativeCredentialPort (readToken/clearToken)
 * @param revoke      (refreshToken) => Promise   best-effort server revocation
 * @param createId    () => string  random installation id
 */
export function createInstallGuard({ marker, credentials, revoke, createId }) {
  if (!marker || typeof marker.read !== 'function' || typeof marker.write !== 'function' ||
      !credentials || typeof credentials.readToken !== 'function' || typeof credentials.clearToken !== 'function' ||
      typeof revoke !== 'function' || typeof createId !== 'function') {
    throw new InstallGuardError('INVALID_ADAPTER');
  }
  let flight = null;

  async function run() {
    let existing;
    try { existing = await marker.read(); } catch { throw new InstallGuardError('MARKER_READ_FAILED'); }
    if (typeof existing === 'string' && MARKER_RE.test(existing)) return { freshInstall: false, purged: false };

    // No (valid) marker: a fresh installation, or sandbox data that was cleared.
    let leftover = null;
    try {
      leftover = await credentials.readToken();
    } catch (error) {
      // A corrupt item is deleted below all the same; any other read failure means we
      // cannot tell what is stored, so we cannot promise it is gone.
      if (error?.code !== 'INVALID_STORED_TOKEN') throw new InstallGuardError('PURGE_FAILED');
    }
    try { await credentials.clearToken(); } catch { throw new InstallGuardError('PURGE_FAILED'); }
    if (leftover) Promise.resolve().then(() => revoke(leftover)).catch(() => {});

    const id = createId();
    if (typeof id !== 'string' || !MARKER_RE.test(id)) throw new InstallGuardError('INVALID_ID');
    try { await marker.write(id); } catch { throw new InstallGuardError('MARKER_WRITE_FAILED'); }
    return { freshInstall: true, purged: leftover !== null };
  }

  return Object.freeze({
    /** Once per process; a failed attempt may be retried by calling again. */
    prepare() {
      if (!flight) flight = run().catch((error) => { flight = null; throw error; });
      return flight;
    },
  });
}
