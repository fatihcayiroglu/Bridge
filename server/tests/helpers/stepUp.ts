// server/tests/helpers/stepUp.ts
//
// P7 B2 — suites that exercise a protected action's own behaviour (2FA setup,
// e-mail change, account export/deletion, server/admin deletion, passkey
// registration) present a REAL step-up grant, exactly as the client does after
// a proof. The guard is never bypassed or disabled in those suites; its own
// refusals are covered by the p7-step-up-* suites.

import jwt from 'jsonwebtoken';
import { STEP_UP_HEADER, mintStepUpGrant, type StepUpMethod, type StepUpScope } from '../../lib/stepUp';

/**
 * `{ 'x-bridge-step-up': <grant> }` for `userId` and `scope`. The default method
 * is a TOTP proof (level 2), which satisfies accounts with and without 2FA.
 */
export function stepUpHeader(
  userId: string,
  scope: StepUpScope,
  { method = 'totp', tokenVersion = 0 }: { method?: StepUpMethod; tokenVersion?: number } = {},
): Record<string, string> {
  return { [STEP_UP_HEADER]: mintStepUpGrant({ _id: userId, tokenVersion }, method, scope).token };
}

/**
 * The same header for whoever `accessToken` authenticates (its `id` and `v`), for
 * suites that only hold the access token they send.
 */
export function stepUpFor(accessToken: string, scope: StepUpScope, method: StepUpMethod = 'totp'): Record<string, string> {
  const claims = jwt.decode(accessToken) as { id?: unknown; v?: unknown } | null;
  if (!claims || typeof claims.id !== 'string') throw new TypeError('stepUpFor needs an access token with an id');
  return stepUpHeader(claims.id, scope, { method, tokenVersion: typeof claims.v === 'number' ? claims.v : 0 });
}
