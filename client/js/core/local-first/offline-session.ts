// P7 A4/A7 — offline reload (owner decision on #497, 2026-10-27).
//
// After every server-validated session start (and every token refresh inside
// one) the client stores an OFFLINE GRANT in the account's encrypted
// local-first store. A later cold start with no reachable server may open
// that account's LOCAL history only if all of these hold:
//
//   · this device already holds the account's non-extractable key
//     (openExistingBrowserLocalFirstStore never creates one);
//   · the grant decrypts and authenticates under that key and account scope;
//   · it is bound to the access token stored now (SHA-256 digest), so a token
//     alone, or a user id alone, opens nothing;
//   · it is younger than OFFLINE_SESSION_MAX_AGE_MS by the device clock, and
//     the clock has not moved behind the validation time;
//   · the account was not erased on this device.
//
// The grant is deleted on logout, account switch, local erasure and any
// explicit 401/403. It never authorizes anything on the server: the server
// validates the session again before any network action.

import { openExistingBrowserLocalFirstStore, createBrowserLocalFirstStore } from './indexeddb.ts';
import { isLocalAccountErased } from './erased-accounts.ts';
import { localDigestHex } from './crypto.ts';

export const OFFLINE_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Tolerated device-clock step backwards before a grant is distrusted. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
const NAMESPACE = 'session';
const RECORD_ID = 'offline-grant';

/** The profile fields the shell needs to render a signed-in, read-only view. */
export interface OfflineUser {
  _id: string;
  id?: string;
  username?: string;
  displayName?: string;
  avatarColor?: string;
  avatar?: string;
}

interface OfflineGrant {
  v: 1;
  userId: string;
  tokenDigest: string;
  validatedAt: number;
  expiresAt: number;
  user: OfflineUser;
}

export type OfflineUnlockFailure =
  | 'no-token' | 'no-account' | 'no-device-key' | 'no-grant' | 'corrupt'
  | 'other-account' | 'token-mismatch' | 'expired' | 'clock' | 'erased';

export type OfflineUnlockResult =
  | { ok: true; user: OfflineUser; validatedAt: number }
  | { ok: false; reason: OfflineUnlockFailure };

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** The account the stored token names. Unverified: it only selects which grant to try. */
export function tokenAccountId(token: string): string | null {
  const part = token.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    const payload = JSON.parse(json) as Record<string, unknown>;
    const id = payload.id ?? payload._id ?? payload.sub;
    return nonEmpty(id) ? id : null;
  } catch {
    return null;
  }
}


function offlineUser(user: Record<string, unknown>, userId: string): OfflineUser {
  const out: OfflineUser = { _id: userId };
  for (const key of ['id', 'username', 'displayName', 'avatarColor', 'avatar'] as const) {
    const value = user[key];
    if (nonEmpty(value)) out[key] = value.slice(0, 512);
  }
  return out;
}

function validGrant(value: unknown, userId: string): value is OfflineGrant {
  if (!value || typeof value !== 'object') return false;
  const g = value as Partial<OfflineGrant>;
  return g.v === 1 && g.userId === userId && nonEmpty(g.tokenDigest)
    && Number.isFinite(g.validatedAt) && Number.isFinite(g.expiresAt)
    && Boolean(g.user) && g.user?._id === userId;
}

/**
 * Records that the server validated `token` for `user` just now. Called only
 * from a server-validated session start or a token refresh inside one.
 */
export async function recordOfflineSession(user: Record<string, unknown>, token: string, now = Date.now()): Promise<void> {
  const userId = nonEmpty(user._id) ? user._id : nonEmpty(user.id) ? user.id : null;
  if (!userId || !nonEmpty(token) || isLocalAccountErased(userId)) return;
  if (tokenAccountId(token) !== userId) return;
  const { store, durable } = await createBrowserLocalFirstStore(userId);
  try {
    if (!durable) return; // nothing survives a reload anyway
    const grant: OfflineGrant = {
      v: 1, userId, tokenDigest: await localDigestHex(token), validatedAt: now,
      expiresAt: now + OFFLINE_SESSION_MAX_AGE_MS, user: offlineUser(user, userId),
    };
    await store.putJson(NAMESPACE, RECORD_ID, grant, now);
  } finally {
    store.close();
  }
}

/** Deletes the account's grant (logout, account switch, erasure, 401/403). Never throws. */
export async function clearOfflineSession(userId: string | null | undefined): Promise<void> {
  if (!nonEmpty(userId)) return;
  const store = await openExistingBrowserLocalFirstStore(userId).catch(() => null);
  if (!store) return;
  try {
    await store.delete(NAMESPACE, RECORD_ID);
  } catch {
    // A grant that cannot be deleted also cannot be read without its key.
  } finally {
    store.close();
  }
}

/** Decides, without the network, whether `token` may open its account's local history. */
export async function unlockOfflineSession(token: string | null, now = Date.now()): Promise<OfflineUnlockResult> {
  if (!nonEmpty(token)) return { ok: false, reason: 'no-token' };
  const userId = tokenAccountId(token);
  if (!userId) return { ok: false, reason: 'no-account' };
  if (isLocalAccountErased(userId)) return { ok: false, reason: 'erased' };
  const store = await openExistingBrowserLocalFirstStore(userId);
  if (!store) return { ok: false, reason: 'no-device-key' };
  try {
    let grant: unknown;
    try {
      grant = await store.getJson<unknown>(NAMESPACE, RECORD_ID);
    } catch {
      return { ok: false, reason: 'corrupt' };
    }
    if (grant === null) return { ok: false, reason: 'no-grant' };
    if (!validGrant(grant, userId)) return { ok: false, reason: 'other-account' };
    if (grant.tokenDigest !== await localDigestHex(token)) return { ok: false, reason: 'token-mismatch' };
    if (now < grant.validatedAt - CLOCK_SKEW_MS) return { ok: false, reason: 'clock' };
    if (now >= grant.expiresAt) return { ok: false, reason: 'expired' };
    return { ok: true, user: grant.user, validatedAt: grant.validatedAt };
  } finally {
    store.close();
  }
}
