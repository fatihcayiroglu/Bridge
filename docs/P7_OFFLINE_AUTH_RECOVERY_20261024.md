# P7 offline bootstrap recovery

Status: client recovery implemented; native first-failure diagnosis remains open.

The handed-off tests reproduce a valid stored session remaining on the login
screen after an offline cold start even after connectivity or foreground state
returns. Against the previous code, the expanded restoration suite reports
15 PASS / 9 FAIL / 0 skipped. No successful response is fabricated.

The client now defers another authoritative `/api/me` validation until an online,
native connected, active-app or visible-document signal. One request sequence
runs at a time, using the existing three transient retries. An offline exception
does not start a repeating polling timer. Exhaustion waits for another external
signal. Initial or recovered HTTP 401/403 responses do not register recovery.

Logout, a new login, two-factor cancellation and other authentication transitions
remove pending recovery listeners and invalidate prior responses. Only a current,
successful server response can enter the existing `startApp` path. No stored
identity alone establishes a session, and no permission or server check changes.

The original test changes were preserved and reused. New assertions cover
rejection during deferred recovery. One handed-off test now observes the failed
bootstrap before emitting connectivity, instead of assuming three microtasks
await the dynamic API import; its exact request-count assertion is retained.
New test casts do not introduce `any`.

Focused authentication tests: 84 PASS / 0 FAIL / 0 skipped. Client typecheck and
the production zero-`any` gate pass. Full combined client coverage, packaged
native acceptance and exact-head CI remain separate gates. These tests do not
prove the cause of Android #209 or #408's historical iOS failure.
