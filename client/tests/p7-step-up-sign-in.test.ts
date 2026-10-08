// client/tests/p7-step-up-sign-in.test.ts
//
// P7 B2 — every sign-in converges on `startApp`, which keeps the sign-in's
// step-up grants in memory (one per scope) so a freshly signed-in person is not
// prompted; a restored session (page reload) carries none and drops any grant
// an earlier session held.

import { afterEach, describe, expect, it } from 'vitest';
import { startApp, logout } from '../js/core/auth-compat.ts';
import { clearStepUpGrants, grantFor, rememberGrant } from '../js/core/step-up.ts';

afterEach(() => {
  clearStepUpGrants();
  try { localStorage.clear(); } catch { /* storage may be unavailable */ }
});

describe('startApp keeps sign-in step-up grants in memory', () => {
  it('stores the grants a sign-in returned, one per scope', async () => {
    const expiresAt = Date.now() + 600_000;
    await startApp('access-token', { id: 'u1', username: 'ayse' }, {
      level: 1, method: 'password', expiresAt, ttlMs: 600_000,
      grants: { 'account-security': 'g1', 'sensitive-export': 'g2', 'destructive-admin': 'g3', 'moderation-burst': 'g4' },
    });
    expect(grantFor('account-security')).toBe('g1');
    expect(grantFor('moderation-burst')).toBe('g4');
    // Grants never reach browser storage.
    expect(JSON.stringify({ ...localStorage })).not.toContain('g1');
  });

  it('a restored session carries no grant and drops the previous session’s', async () => {
    rememberGrant('destructive-admin', 'previous-session', Date.now() + 600_000);
    await startApp('access-token', { id: 'u2', username: 'other' });
    expect(grantFor('destructive-admin')).toBeNull();
  });

  it('signing out drops the grants', async () => {
    await startApp('access-token', { id: 'u1', username: 'ayse' }, {
      expiresAt: Date.now() + 600_000, grants: { 'sensitive-export': 'g2' },
    });
    logout();
    expect(grantFor('sensitive-export')).toBeNull();
  });
});
