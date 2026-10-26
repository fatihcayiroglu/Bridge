# EX02: verified JavaScript pause before the storage comparison

Android [40325425203](https://github.com/fatihcayiroglu/Bridge/actions/runs/40325425203)
at `0f4ad62bb569586d9fde001b641e0d37d9975811` reproduced the EX01 first
cold-start channel mismatch, then identified the EX02 failure precisely:
`stage=freeze`, `substep=freeze-event`, `deadlineExceeded=true`. The freeze
command acknowledged, but no actual freeze event was confirmed. No paused
storage or post-control boot result exists for that run. Cleanup and CR00 passed.

An isolated real Chromium 151 / Playwright 1.61.1 control reproduced the missing
DOM freeze event after an acknowledged lifecycle command. The page remained
visible. Window minimization and disabling focus emulation on the additional
CDP session did not correct it; these failed controls are retained. Do not claim
a proven focus-emulation root cause or an application persistence fix.

Use the standard debugger protocol to suspend JavaScript instead. A pause
request alone also failed on an idle control page: it waits for JavaScript
execution. A side-effect-free `Runtime.evaluate('void 0')` triggers that request.
The helper requires the actual `Debugger.paused` event before browser storage
is read, holds the evaluation promise until resume/target teardown, tracks
`Debugger.resumed`, and removes only its own listeners. Event payloads and
protocol errors never enter evidence. No application expression is evaluated.

Reuse the existing controller and bounded storage projection, renamed to
`paused-preference-control.mjs`. Check the paused state before and after the
browser read and again before Android stop. A resumed/unknown state, missing
event, failed baseline or unverified cold launch cannot advance. Cleanup
resumes a surviving target, disables this debugger agent, settles its trigger
and detaches; a closed old target is handled explicitly. No retries or sleeps
are added. Existing 100-second action and five-second cleanup budgets remain.

Evidence now uses `androidPausedPreferenceControl`, `method=debugger-pause`,
`pauseEventObserved`, `beforePause` and `paused`; it never calls a debugger event
a DOM freeze event. Retain the historical lifecycle-freeze artifacts as failures.
The separate comparison still runs only after the original qualifying EX01
failure, which stays failed and gating. All 93 existing journey assertion lines
remain. Physical/production-package scope is still refused.

## Verification and limits

All 161 Android Node tests pass with zero failures/skips/todo. Negative controls
cover a pause ACK without an event, early resume, resume during a storage read,
domain/request/trigger errors, target teardown, late completion after deadline,
private values, and listener ownership. The mandatory Chromium spec
`e2e/tests/debugger-storage-pause.spec.ts` drives the real debugger and DOMStorage
agents, verifies the private-value projection, resumes and executes JavaScript
again. Its local Chromium run passes with zero retries/skips; it is included in
the normal full Chromium project. The local document is synthetic, the protocol
and browser are real. This is not Android platform acceptance. A sandbox-enabled
local Chromium launch failed before protocol work; the successful local controls
use the project's standard Playwright launch defaults.

Exact-head Android and full Quality Gate results remain required. Pausing one
renderer does not rule out other storage writers or pending native I/O, and a
retained boot value is non-reproduction, not a production durability fix. The
new control changes timing and does not force or prove a disk flush. The original
FocusEvent ANR, EX01 storage mismatch, #209 and #321 remain unresolved. Keep this
draft stack and #375 unmerged.
