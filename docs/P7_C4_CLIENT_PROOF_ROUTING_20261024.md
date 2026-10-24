# C4 — renew stale community-import proofs through the existing client

Community portability routes were absent from the client's protected-request
scope table. They therefore started without the account-security grant held
in memory. On the server's missing-proof refusal, the existing API client used
that held grant for its single retry. If the grant was still valid for ordinary
account actions but too old for community approval/apply, that retry returned
`step_up_stale`. The action ended without prompting for a fresh proof. Repeating
the action repeated the same two refusals until the held grant expired or the
owner signed in again.

Two negative controls run the real client API/proof modules with HTTP boundary
responses matching the server's missing/stale-proof behavior. Both initially
fail: approval returns 403 instead of 201 and apply returns 403 instead of 200;
the other 56 tests pass, with zero skips. This is client integration evidence,
not an actual browser or independent-installation acceptance result.

The correction adds only exact C4 route declarations to the existing scope
table: community exports use sensitive-export; the destination fingerprint,
reviews, approval and apply use account-security. The held grant now travels
on the first request. An authoritative stale refusal makes the existing proof
owner discard it, ask once, and retry with the fresh grant. No retry loop,
proof lifetime, prompt implementation, token storage, permission, server
step-up internals or channel-administration behavior changes.

Local checks pass 156 tests across eight API/proof/portability test files with
zero skips, including cancellation without resubmission and exact method/path
negative controls. Client types, strict types, bridge typecheck, ESLint and the
production build pass. Full coverage and exact-head CI remain separate gates.

## Shared configuration dependency

The five-line production diff is isolated in this C4 branch and changes only
the declarative table in `client/js/core/step-up.ts`. Claude owns D2/channel
step-up work, potentially including uncommitted entries in the same table.
Integration must preserve both sets of declarations. This branch does not
modify, replace or independently recreate Claude's channel implementation or
shared proof-handling functions. It is a dependent draft following #389 and
requires normal integration review; nothing is merged into main.

Keep #205 open. A live browser UI journey across two installations, production
operator/domain acceptance, physical-device evidence and the explicit product
scope acceptance remain separate from these executable client regressions.
