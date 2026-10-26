# Android DL02: correlate bounded Java crash evidence

The cause of the cold deep-link failure remains unknown. This change adds
failure diagnostics to the emulator harness, not a product lifecycle patch.
The FocusEvent ANR in #209 also remains unresolved; #209/#321 stay open.

## Verified gap

On `cea773d3`, [Android 40250505439](https://github.com/fatihcayiroglu/Bridge/actions/runs/40250505439)
reported **35 PASS / 1 FAIL / 0 SKIPPED / 6 MEASURED**. DL02 timed out
attaching to the WebView at the original 60-second deadline. The app PID and
DevTools socket were absent. The global crash buffer contained a fatal marker;
the journey's own exit ledger recorded one reason-4 CRASH, but its exception
and exact timing were not retained. The global marker alone does not identify
the crashing process. The original failure/artifact remain preserved in #468.

The different head `9cf16edf` passed Android **36/0/0/7** and Quality Gate
**9/9**, including 666 browser/media cases. That green result does not diagnose
or cancel the earlier failure. No unchanged failing test was rerun to get green.

## New evidence

DL02 samples one device clock **before** the cold launch. The sample pairs
epoch nanoseconds, local calendar time and timezone offset from a single `date`
command. The parser requires those representations to agree. Unavailable,
coarse, inconsistent or changing-timezone clocks leave attribution unknown.
Its successful journey detail records only `crashClockAvailable`, not the clock.

After an attachment failure, the existing failure-only probe reads up to 200
epoch-format crash-log lines, this package's bounded ApplicationExitInfo rows,
and a closing device clock. All raw data stays in memory. An exception record
qualifies only when:

- A fatal AndroidRuntime record and its following Process line have the same
  emitter PID/TID, exact expected process name and matching identity PID.
- The log record falls inside the device-clock observation window, bounded to
  two minutes consistently with the existing fresh-exit matcher.
- The existing PID/process/window matcher finds an own reason-4 OS exit.
  Additional checks narrow its legacy two-second grace to the exact window.

A stale/reused PID, foreign/subprocess name, native signal, wrong reason or
missing OS corroboration cannot provide Java crash attribution. The existing
global `crashBufferHasFatalMarker` retains its deliberately global meaning.

The new `appCrash` summary contains only window/availability booleans, a coverage
category, a truncation flag, and at most three records. A record reports a fixed
thread category, allowlisted exception category, startup context, last observed
cause category and cause depth. Unknown classes become `other`; private classes,
messages, stack locations, process names, PIDs and timestamps are never copied.
Standard finalizer-watchdog timeouts remain distinguishable without exporting
their messages. Cause depth is capped at eight; input is capped at 262,144
characters and 200 lines. Truncation stays visible.

Coverage is `unknown`, `observed-only` or `partial`, never complete. The last
observed cause is not certified as the root cause. Logger text and an OS exit
correlation are diagnostic observations, not a security authorization mechanism.
Missing or rotated records cannot prove there was no crash.

## Acceptance and validation

All 87 original journey assertion lines and all 82 original parser tests remain.
DL02 retains the 60-second attachment deadline and its original channel/session
assertions. No retries, cold-recovery substitution, skips, product code,
production Android source or dependencies are introduced. The additional
clock/ADB reads add observation overhead; recurrence frequency is not a causal
experiment. Probe failures leave unknown evidence and preserve the original FAIL.

The parser/contract suite now has **101 tests**, all passing with zero skips/todo cases.
It covers timezone and epoch consistency, foreign processes, emitter/identity/OS
PID mismatches, stale/future records, exact-window narrowing, OS reason matching,
PID reuse, interleaving, unknown/spoofed classes, bounded records/causes/input,
truncated records, privacy and harness wiring. Deliberately removing OS
corroboration, exact-window narrowing or process equality each caused relevant
negative-control tests to fail. Original code was restored and the full suite passed.
The production client build and mobile Jest **142/142**, with no skipped or todo
tests, also passed locally; the build ran before the packaged-shell tests.

### CR00: real-emulator calibration after product acceptance

A debug-only `JavaCrashControlActivity` finishes its empty Activity and posts a
known `IllegalStateException` on its main thread after 500 ms. It initializes
no Bridge/WebView and reads no user data. CR00 refuses production package names
and devices that do not identify themselves as emulators, before any mutating
ADB command. The release manifest has no control and the release variant
compiles without its debug source set.

The emulator runner invokes CR00 **after** the product runner has exited and
written its evidence. It cannot warm the initial startup, change an earlier
ANR window or insert an expected crash into the product exit ledger. It launches
the control once and waits for asynchronous OS recording; it never relaunches,
clears logs or injects mock evidence. It requires one OS-correlated main-thread
`illegal-state` record through the exact shared probe/parser used by DL02.

CR00 writes a separate, enum-only `java-crash-control.json` with its own status;
it is not counted as a product journey PASS. The CI job fails when either
product journeys or CR00 fail, preserving the original product exit code if
both fail. Shell-contract tests verify this matrix, including running CR00
after a product failure. CLI guard unit tests verify physical devices and
production packages are rejected without force-stop/start calls. These local
stub-based contracts are not native acceptance; actual CR00 requires CI.
The job summary reports CR00 separately and fails missing, stale, mismatched or
non-emulator control evidence; it never inflates the product PASS count.

Real-device exception attribution still needs an actual recurrence; synthetic
parser fixtures and a green emulator journey do not establish the failure's
cause. Exact-head CI results belong in the PR when actually completed. Physical
device acceptance remains unverified. #375 remains unmerged and #467 stays closed.
