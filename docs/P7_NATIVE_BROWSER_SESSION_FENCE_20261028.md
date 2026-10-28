# P7 native browser sign-in session fence

The pilot's production wiring awaited browser consent and code exchange, then
unconditionally called coordinator.signIn. A late response could therefore sign
in A after sign-out, account deletion or adoption of B. A newer browser request
could also be overtaken while the old token exchange was still in flight.

The production orchestration now reserves invocation order synchronously and
checks both session epoch and trust phase before exchange and before adoption.
A discarded issued refresh token is best-effort revoked, never persisted, and
never used to clear the newer account's storage. Failed orphan revocation still
refuses adoption; it does not claim successful server cleanup.

Two related ordering defects were reproduced and corrected:

- Browser PKCE preparation reserved its pending slot only after native crypto
  completed. A slower older preparation could replace the newer browser request.
  The slot is now reserved before the first await. Preparation errors are bounded
  to PKCE_FAILED and cannot clear a newer request.
- A synchronous coordinator subscriber could sign out during the restoring
  notification, queue a clear, then have the older sign-in queue a write after
  that clear. The coordinator now rechecks ownership before queuing that write.

The extracted original three-step orchestration plus the original coordinator
failed 6 of 7 race contracts; the normal completion control passed. The original
PKCE ordering failed all 3 new deterministic controls. Original outputs remain
preserved. An initial version of the ordering test waited on the very unresolved
browser operation it needed to release; it was stopped and corrected to settle
both controlled operations before assertions. No production timeout was changed.

Local verification: 126 portable Node tests pass, zero failed/cancelled/skipped,
TypeScript passes, exact npm ci reports zero vulnerabilities. The 36 shell-based
contracts are left to the complete Linux CI suite, not counted as local passes.
A first bulk command used the repository root instead of the pilot directory;
those path failures are retained separately from the corrected invocation.

The real PostgreSQL 16/Redis integration suite adds two cases (18 total): hold a
real issued code-exchange response, then sign out or adopt B before releasing
it. Assert the stale result is refused, local storage belongs to the current
session, the orphan refresh is rejected by the actual server, and B still reads
and rotates successfully. Existing consent, PKCE, replay and outbox assertions
remain unchanged; all integration sign-ins use the production orchestrator.

CI/backend/native results on the exact commit are required separately. Node
contracts and HTTP-driven browser consent do not prove Custom Tabs,
ASWebAuthenticationSession, OS callback association or the complete native
messaging journey. Existing native runtime checks remain SecureStore/SQLCipher
regression acceptance. #537 stays disabled pending owner domain/signing inputs;
#533's separate security change and original histories are preserved. P7 stays
open; no production merge, Capacitor migration, deployment or Abuse Lab change.
