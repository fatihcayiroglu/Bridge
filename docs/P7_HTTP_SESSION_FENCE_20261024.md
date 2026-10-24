# P7 local authentication-context fencing

Status: reproduced client security defects corrected; final CI remains required.
No backend permission, token validation, CSRF or step-up requirement is relaxed.

## Reproduction

Five HTTP tests fail against `8c71b2d2` with no skipped cases:

- Refresh persists the old account's access token after logout or another login.
- The old refresh completion clears the new account's single-flight promise.
- An old mutation's late 401 causes refresh and replay using the new account.
- An old mutation is sent after its CSRF preflight completes in another session.

Three step-up tests fail independently: an old prompt submits after sign-in,
a late proof overwrites a new sign-in grant, and an old sign-in-again confirmation
signs out the new account. Two real-dialog tests additionally reproduce an old
password field remaining visible and populated after authentication changes.

## Correction

Authentication transitions invalidate pending HTTP work before starting another
login. Invalidation runs during capture, before ordinary sign-in consumers can
start fresh requests, regardless of dynamic-import registration order. Socket
recovery is cancelled at the start of the transition, before a replacement
login completes. Refresh/CSRF requests receive abort signals; generation and job checks
also discard delayed replies when the transport ignores cancellation. Stale
refreshes cannot set failure state, clear a successor, publish coordinator
results or release its lease. Normal same-session refresh/CSRF single flight
and cross-tab coordination controls remain tested.

Each authenticated HTTP request keeps its original local context across awaits,
including CSRF repair, refresh, step-up and retries. A superseded request returns
the bounded `409 AUTH_SESSION_CHANGED` cancellation response; it cannot replay
its body or hand a delayed successful response to a different account. An
already transmitted request may already have committed on the server; this
does not undo a committed action or claim distributed cancellation.
An original 401 that terminates its own session remains a 401, provided no
replacement account or later context has superseded that terminal logout.

Step-up prompts, proof results, confirmation callbacks and pending-scope cleanup
are similarly fenced. Authentication transitions close the existing canonical
product dialog and clear its input value. Sign-in grants are installed after
invalidation so fresh proofs remain usable. No credential is added to logs,
browser storage or URLs.

## Validation and limits

Final combined HTTP, coordinator, authentication, socket and dialog suites:
**232 PASS / 0 FAIL / 0 skipped**. Added controls include late JSON parsing,
stale failure responses, successor refresh/CSRF/prompt concurrency, shared lease
completion, real dialog cancellation and ordinary sign-in/refresh behavior.
Full client coverage, typechecks, build and exact-head native CI are separate
gates. This addresses local asynchronous account transitions; it is not a new
cross-device session protocol, E2EE implementation, native ANR diagnosis or
proof of the cause of #408's original iOS failure. P7 and #321 remain open.

Additional first-failure evidence is retained: the initial HTTP implementation's
full client run reports **5,699 PASS / 1 FAIL / 0 skipped**. The failure is the
existing real-auth test requiring its own terminal 401; its assertion is
unchanged and now passes. A new import-order control initially fails 409 vs 200,
and two socket controls initially fail while a replacement login is still
pending. Capture-phase invalidation and transition-time socket teardown correct
those regressions. Full coverage must run again on the corrected commit.

## Follow-up: account deletion after asynchronous session revocation

The server commits `DELETE /api/account`, invalidates credentials, and
disconnects live sessions **before** returning HTTP 200. The resulting
`bridge:auth-logout` can supersede the HTTP generation while the success
response is still in flight. Previously, `apiFetch` converted that successful
response into a generic 409, so the Privacy tab neither confirmed deletion
nor erased the deleted account's local-first storage. The tab also looked up
the account identity *after* the response, when it could already be cleared.

The correction preserves only an internal, unforgeable acknowledgement on the
otherwise opaque `409 AUTH_SESSION_CHANGED` response, scoped strictly to the
exact `DELETE /api/account` call. The old response body is never released to a
replacement account. The Privacy tab captures the original account identity
before transmission, erases only that account after a confirmed acknowledgement,
and never signs out a replacement login even when local erasure finishes late.
An ordinary 409, unrelated response, error or unconfirmed network failure does
not authorize local data erasure. A committed deletion whose response is
**lost entirely** remains an unknown-result case; no proof is fabricated.

Focused verification: 24 account-deletion/HTTP lifecycle tests PASS, zero
skips. New cases include revocation before the HTTP acknowledgement, a new
login before the acknowledgement, a new login during local erasure, and an
unmarked 409 negative control. Production and strict client typechecks plus
client lint PASS. The full client coverage suite passed **5,712/5,712 tests
across 339 files, zero skips**, when run with `TZ=UTC`: statements 95.52%,
branches 90.58%, functions 94.86%, lines 96.54%. The initial local run under
`America/Toronto` exposed two unrelated pre-existing tests assuming UTC dates
(5,710 PASS / 2 FAIL); both passed unchanged under UTC, as did the whole suite.
Svelte checks reported 0 errors and 0 warnings; the production build and its
existing overall bundle budgets pass (four sub-budget warnings remain).
Native acceptance and exact-head CI are independent gates; this patch is not
an Android ANR or iOS I07 resolution.
