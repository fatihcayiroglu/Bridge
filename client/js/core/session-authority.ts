// Who vouches for the current session (P7 offline reload, owner decision on
// #497). 'server': /api/me or a sign-in response validated it. 'local': it was
// opened offline from the account's offline grant
// (local-first/offline-session.ts) and may only read local data until the
// server validates it again. Written only by auth-compat.ts.

export type SessionAuthority = 'none' | 'server' | 'local';

let authority: SessionAuthority = 'none';

export function sessionAuthority(): SessionAuthority {
  return authority;
}

export function setSessionAuthority(next: SessionAuthority): void {
  authority = next;
}

/** True while the session has no server authority. api-fetch.ts sends nothing but the /api/me check then. */
export function isLocalOnlySession(): boolean {
  return authority === 'local';
}
