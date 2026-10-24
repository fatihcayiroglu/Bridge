# Deletion callbacks must belong to the active UI operation

This extends #417; its private deletion acknowledgement and captured-account
local erasure remain the single implementation. The HTTP/session fence already
suppresses an old response body, but an old callback can still close a newer
account's deletion form, clear its password or display a decoded ownership
blocker from the previous account. A preflight response can do the same.

The Privacy tab now assigns a local operation sequence to preflight and confirmed
delete requests, invalidates it on cancellation, identity transition and component
destruction, and checks ownership after asynchronous body decoding. A stale
confirmed deletion still erases only the account captured by #417. Its foreground
callback cannot mutate a newer form. Denied proofs, wrong passwords, ownership
conflicts and lost acknowledgements retain their existing failure behavior;
network loss is not proof of committed deletion.

Evidence on the #420/#417 baseline, in a separate unchanged source worktree:
**10 PASS / 7 FAIL / 0 skipped**. Failures cover old success, HTTP 400/409/503,
preflight, network rejection and a delayed ownership-conflict body crossing an
account transition. The new suite drives the real Svelte component, auth owner,
registry and HTTP client; only transport and the local erasure backend are
replaced. That is client regression evidence, not a PostgreSQL or native test.

Corrected focused suites: **41 PASS / 0 FAIL / 0 skipped**. Full client:
**5,729 tests / 340 files PASS**, zero skipped; all-source and production-reachable
coverage S95.53/B90.60/F94.86/L96.56, unchanged thresholds. Production/strict/bridge5
TypeScript, Svelte (zero errors/warnings), client lint, zero-any and build PASS.
The real full-matrix account-deletion E2E assertion remains unchanged.

Exact-head CI, review and the remaining P7 criteria remain required. No production
merge, release or deployment; #375, #321, Android #209, iOS I07, Wayland #416 and
physical-device acceptance are not closed by these local results.
