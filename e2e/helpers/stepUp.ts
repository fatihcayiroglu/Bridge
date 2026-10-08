// e2e/helpers/stepUp.ts — P7 B2 step-up for API-driven specs.
//
// Protected actions (2FA changes, e-mail change, passkeys, export, deletions,
// and destructive moderation past the 5-per-60 s burst) answer
// `403 STEP_UP_REQUIRED` until a fresh, scoped proof is presented in
// X-Bridge-Step-Up. In the product the client asks the person for ONE proof and
// retries (client/js/core/step-up.ts). Specs that drive the API directly as a
// signed-in fixture person do the equivalent here: the person signs in again
// (every sign-in returns one grant per scope), the grants are held IN MEMORY for
// their lifetime, and the refused request is retried once.
//
// The guard is never bypassed: a person whose password the suite does not know,
// or whose sign-in needs a second factor, simply keeps the 403. Specs that test
// the refusal itself send `x-e2e-no-step-up: 1` (stripped before sending).

import type { APIRequestContext } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const BASE = () => process.env.BASE_URL || 'http://127.0.0.1:3000';
const TOKENS_FILE = path.join(__dirname, '..', 'fixtures', 'tokens.json');
const BROWSER_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
};

export const STEP_UP_HEADER = 'X-Bridge-Step-Up';
export const NO_STEP_UP_HEADER = 'x-e2e-no-step-up';

type Credentials = { username: string; password: string };
const known = new Map<string, Credentials>(); // username → credentials
const grants = new Map<string, { grants: Record<string, string>; expiresAt: number }>(); // username → held grants

/** Registers credentials a spec created itself (e.g. registerFreshUser). */
export function rememberCredentials(username: string, password: string): void {
  known.set(username, { username, password });
}

function usernameOf(bearer: string): string | null {
  try {
    const payload = JSON.parse(Buffer.from(bearer.split('.')[1] ?? '', 'base64url').toString('utf8')) as { username?: unknown };
    return typeof payload.username === 'string' ? payload.username : null;
  } catch {
    return null;
  }
}

function credentialsFor(bearer: string): Credentials | null {
  const username = usernameOf(bearer);
  if (!username) return null;
  const remembered = known.get(username);
  if (remembered) return remembered;
  try {
    const tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')) as { users?: Record<string, Partial<Credentials>> };
    for (const user of Object.values(tokens.users ?? {})) {
      if (user?.username?.toLowerCase() === username.toLowerCase() && typeof user.password === 'string') {
        return { username: user.username, password: user.password };
      }
    }
  } catch { /* no fixture file: nothing to prove with */ }
  return null;
}

/** The scope a response refuses for, or null when it is not a step-up refusal. */
export async function stepUpScopeOf(res: { status(): number; text(): Promise<string> }): Promise<string | null> {
  if (res.status() !== 403) return null;
  try {
    const body = JSON.parse(await res.text()) as { error?: unknown; scope?: unknown };
    return body.error === 'STEP_UP_REQUIRED' && typeof body.scope === 'string' ? body.scope : null;
  } catch {
    return null;
  }
}

/** A grant for `scope` for whoever `bearer` is — by signing that person in again. */
export async function stepUpGrant(request: APIRequestContext, bearer: string, scope: string): Promise<string | null> {
  const who = credentialsFor(bearer);
  if (!who) return null;
  const held = grants.get(who.username);
  if (held && held.expiresAt - 30_000 > Date.now() && held.grants[scope]) return held.grants[scope]!;
  const res = await request.post(`${BASE()}/api/login`, { headers: BROWSER_HEADERS, data: { username: who.username, password: who.password } });
  if (res.status() !== 200) return null; // 202 = second factor needed; 429 = login budget: keep the refusal
  const body = await res.json() as { stepUp?: { expiresAt?: number; grants?: Record<string, string> } };
  if (!body.stepUp?.grants) return null;
  grants.set(who.username, { grants: body.stepUp.grants, expiresAt: Number(body.stepUp.expiresAt) || Date.now() + 9 * 60_000 });
  return body.stepUp.grants[scope] ?? null;
}

/** A grant already held for `scope` (no request), or null. */
export function heldStepUpGrant(bearer: string, scope: string): string | null {
  const username = credentialsFor(bearer)?.username;
  const held = username ? grants.get(username) : undefined;
  return held && held.expiresAt - 30_000 > Date.now() ? held.grants[scope] ?? null : null;
}

/** Drops held grants (e.g. after a spec signs a person out everywhere). */
export function forgetStepUpGrants(): void {
  grants.clear();
}
