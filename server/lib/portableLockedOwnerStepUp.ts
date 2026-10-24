// P7 C4: strictly verify the destination OWNER's fresh account.import
// credential proof against CURRENT database factor and token-version state,
// using the SAME caller-owned SERIALIZABLE PostgreSQL transaction client.
// UNMOUNTED: not consent, token issuance, or an import/apply endpoint.
import { checkStepUpGrant, factorsOf, STEP_UP_ACTIONS } from './stepUp';

type Row = Record<string, unknown>;
type Client = { query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }> };
const MAX_OWNER_ID = 256;
const MAX_FRESH_MS = 120_000;
/**
 * HTTP-side bound for approval/apply: tighter than MAX_FRESH_MS so a proof
 * accepted at the route has a small freshness margin. Database waits are
 * unbounded by that margin: the transaction must resample time after them.
 * A staler proof gets 403 STEP_UP_REQUIRED
 * (`step_up_stale`) and the client asks once for a fresh one.
 */
export const PORTABLE_OWNER_PROOF_ROUTE_MAX_AGE_MS = MAX_FRESH_MS - 20_000;

export class LockedPortableOwnerStepUpError extends Error {
  readonly code = 'PORTABLE_OWNER_STEPUP_UNAVAILABLE';
  constructor() {
    super('Fresh portable import owner authorization unavailable');
    this.name = 'LockedPortableOwnerStepUpError';
  }
}
function refuse(): never { throw new LockedPortableOwnerStepUpError(); }

/**
 * Must run on the EXACT destination writer transaction client, already
 * begun SERIALIZABLE READ WRITE. Never trust a detached Users.findById,
 * client-provided factors, or the optional STEP_UP_DISABLED_SCOPES switch.
 * A valid scope grant is only an identity/credential proof — NOT the owner's
 * explicit decision to approve the selected source-to-target mappings.
 */
export async function requireLockedPortableOwnerStepUp(input: {
  client: Client;
  ownerId: string;
  stepUpGrant: unknown;
  now?: number;
}): Promise<{
  mode: 'transaction-check-only';
  action: 'account.import';
  stepUpVerified: true;
  consentVerified: false;
  tokenIssued: false;
  writesPerformed: false;
  importSupported: false;
}> {
  try {
    const owner = input.ownerId;
    let now = input.now ?? Date.now();
    if (typeof owner !== 'string' || !owner || owner.length > MAX_OWNER_ID ||
        owner.trim() !== owner || /[\x00-\x1f\x7f]/.test(owner) ||
        !Number.isSafeInteger(now) || now < 0) refuse();

    const session = await input.client.query(
      "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS readonly, txid_current()::text AS txid",
    );
    if (!session || session.rows.length !== 1 ||
        session.rows[0]?.isolation !== 'serializable' ||
        session.rows[0]?.readonly !== 'off' ||
        typeof session.rows[0]?.txid !== 'string' ||
        !/^[1-9][0-9]*$/.test(session.rows[0].txid)) refuse();

    const current = await input.client.query(
      'SELECT _id, "tokenVersion", "twoFactorEnabled" FROM users WHERE _id=$1 FOR SHARE',
      [owner],
    );
    if (!current || current.rows.length !== 1 || current.rows[0]?._id !== owner) refuse();
    const row = current.rows[0];
    if (!Number.isSafeInteger(row.tokenVersion) || (row.tokenVersion as number) < 0 ||
        typeof row.twoFactorEnabled !== 'boolean') refuse();

    // Isolation config alone does NOT prove an explicit transaction: a
    // serializable autocommit session can run both statements in DIFFERENT
    // transactions. Require the same PostgreSQL xid across both reads.
    const ending = await input.client.query('SELECT txid_current()::text AS txid');
    if (!ending || ending.rows.length !== 1 ||
        ending.rows[0]?.txid !== session.rows[0].txid) refuse();

    // FOR SHARE (or the final round trip) can wait past the freshness window.
    // Validate against the time AFTER all awaited evidence, never entry time.
    now = input.now ?? Date.now();
    if (!Number.isSafeInteger(now) || now < 0) refuse();
    // Bypass switches for lower-risk actions MUST NOT turn on consent.
    const proof = checkStepUpGrant(input.stepUpGrant, owner,
      factorsOf({ tokenVersion: row.tokenVersion, twoFactorEnabled: row.twoFactorEnabled }),
      STEP_UP_ACTIONS['account.import'].scope, now);
    if (!proof.ok) refuse();
    const iatMs = proof.claims.iat * 1000;
    // The generic step-up JWT may live for 10 minutes. Import approvals
    // require a truly recent credential proof (<= 120 seconds).
    if (!Number.isSafeInteger(iatMs) || iatMs > now ||
        now - iatMs > MAX_FRESH_MS) refuse();

    return {
      mode: 'transaction-check-only',
      action: 'account.import',
      stepUpVerified: true,
      consentVerified: false,
      tokenIssued: false,
      writesPerformed: false,
      importSupported: false,
    };
  } catch {
    return refuse();
  }
}
