# Android #209: bounded operation evidence

The FocusEvent ANR's cause remains unknown. This change improves the existing
debug-only ANR02 postmortem classifier; it changes no product lifecycle, timing,
dependency, acceptance assertion or timeout. Issue #209 remains open.

## Preserved failure

[Android run 40245957721](https://github.com/fatihcayiroglu/Bridge/actions/runs/40245957721)
on `d7f971c4aa4fdfff1fc6c313a550f5c8d1f12445` reported **33 PASS, 3 FAIL,
0 SKIPPED, 6 MEASURED**. CS01, L01 (COLD instead of the required HOT resume),
and ANR01 failed. FD01, PD01 and D2L01 passed.

Its retained ANR02 trace summary was `Runnable / running-code / capacitor /
nativeHint=none`. CPU summaries reported total 98%, app 0%, system_server 26%
before, and total 98%, app 40%, system_server 15% after. These are observations,
not attribution to Capacitor, GC, WebView, the emulator host or a particular
method. No raw stack was retained in the artifact, so the new categories
cannot be recovered retroactively from that run.

The downloaded `android-emulator-evidence` artifact (ID `12618619535`) matched
GitHub's SHA-256
`0afa6399a50b3709606293bcd0caa61740316dfe5c6be7a9669e2ea73f6005ee`.
Screenshots and server logs are not republished here.

The independent combined preview #467 remains closed without merge. Its
Android sources, workflow and harness are identical to #465 at
`c0960bad1f9fe1a79f8173f7e4dcd3e3acb1302e`, the base of this diagnostic
branch. Its [push Quality Gate 40245836734](https://github.com/fatihcayiroglu/Bridge/actions/runs/40245836734)
has now completed with all nine jobs successful, including full browser/media
coverage. That success does not cancel the Android failure.

## Verified classifier defect

The old Java-frame regex ignored ART's `<init>` and `<clinit>` method names.
A synthetic main-thread stack starting with `com.getcapacitor.Bridge.<init>`
and followed by `com.bridge.app.MainActivity.onCreate` was incorrectly reduced
to `subsystem=bridge`. The new regression failed on that exact mismatch before
the correction (5 existing tests passed, 1 new test failed).

Constructors and static initializers now participate in both first-frame and
first-owner selection and in the existing 24-Java-frame limit. This proves a
classifier defect, not that the historical ANR contained a constructor.
Binder classification also requires the exact known method, rather than
accepting a method-name prefix.

## Evidence contract

The existing four-field marker stays available. The debug probe appends two
independent, fixed-category fields:

| Field | Meaning |
| --- | --- |
| `topOperation` | Operation category of the first parsed Java frame in the main-thread block. Native frames are still described separately by `nativeHint`. |
| `ownerOperation` | Category of the first non-framework Java owner used for `subsystem`; it may be a deeper caller, not the operation currently executing. |

For example, `topOperation=class-load ownerOperation=capacitor-plugins`
distinguishes a class-loader frame called by plugin initialization from a
sample directly inside the Capacitor bridge constructor. A deeper recognized
method never replaces an unknown first owner to produce a more specific hint.

Known operations cover looper, binder, sleep, monitor wait, class loading,
reflection, asset reading, WebView construction/navigation/focus, Capacitor
construction/plugins/scripts/lifecycle/message dispatch, and Bridge lifecycle.
Capacitor entries were checked against the lockfile-pinned Android 8.4.3 source.
Recognition uses exact fully qualified methods. Unknown methods reduce to
`other`; otherwise-unknown constructors/static initializers reduce to
`constructor`/`class-init`. `none` means no corresponding Java frame was found
inside the scan boundary, not that the thread was idle.

Only these fixed literals leave the classifier. Raw classes, methods, stack
locations, native symbols, arguments, thread IDs, process IDs and timestamps
are never copied to the new fields. The existing one-MiB trace read, first-main
block boundary, 24 Java frames, 24 native frames and five-exit caps remain.
The harness revalidates both fields using its own allowlist and exact probe
PID. It rejects unknown, partial or extended markers. Historical markers are
still accepted with the operation fields absent; absence is not synthesized
as `none`.

ANR02 remains measurement-only, after the strict ANR01 gate. All the CS01,
L01, ANR01, FD01 and PD01 acceptance requirements remain unchanged. The
classifier/probe remain in the debug source set only; the workflow separately
compiles the release variant without them.

## Validation and remaining work

The JVM regression and Node parser contracts exercise constructor attribution,
separate first-frame/first-owner selection, reflection, asset reading, WebView
construction, lifecycle/message separation, unknown and spoofed methods,
thread/frame bounds, missing traces, historical compatibility, exact-PID
filtering, malformed fields and bounded records. The new parser protocol tests
first reported 69 PASS, 2 FAIL, 0 SKIPPED against the old consumer.

Local validation after the correction: **14/14 classifier JVM tests**, **71/71
Android exit-parser contracts**, and **142/142 mobile Jest tests**, all with
zero skipped tests. The packaged client was built before mobile Jest, so the
packaged-shell cases executed. The JVM tests used Java 21 with source/target
17; these standalone tests do not substitute for Android Gradle or emulator
acceptance. Client production build, Node syntax and Git whitespace checks
also passed.

Exact-head Gradle, release compilation and API 34 emulator results belong in
the PR evidence when actually completed. A successful emulator run without a
fatal ANR does not exercise these postmortem categories on a real failure and
does not resolve #209. Even a populated category is a single sampled Java
stack, not a duration, native blocking operation or causal intervention.

The next recurrence needs the new categories together with the ANR03 lifecycle
timeline from unmerged #340/#342, ANR CPU and font-release/ART pause measurements.
ANR03 is absent from the standalone operation-evidence head `cea773d3`; the
separate timeline integration below adds it.
If those still cannot identify a blocking operation, a controlled experiment
must separate workload and scheduling pressure before changing product code.
Physical-device acceptance remains unverified.

## Reusing the unmerged timeline work

The separate timeline integration reuses the diagnostic commits from #340 and
the corrections from #342, with their authorship and original commit references
preserved:

- `2dfddd57`: ANR03 event timeline, dialog sampling and debug-only AN00 controls.
- `80a508a3` / `ce8b6b22`: observation bounds, foreign/stale event rejection and
  separate process incarnations when Android reuses a PID.
- `254668a2` / `ca76c6c9`: read failures and coverage remain visible.
- `aa503861`: observed evidence is never presented as complete history.

Conflict resolution retains the current privacy-redaction imports/tests and
the newer recurrence documentation. It retains the 71 operation/privacy/exit
parser tests and adds the 11 existing timeline tests: **82/82 PASS, 0 skipped**
locally. The production client build and mobile Jest **142/142, 0 skipped**
also passed. Every pre-existing journey assertion remains. No client, server,
production Android source, dependency or workflow changes are included.
Three deliberate local parser mutations (accept a foreign process, accept a
pre-journey ANR, reuse one process ordinal across new starts) each failed the
relevant negative-control tests. The original source was restored and all 82
tests passed afterward; the intentional failures are not product failures.

The old SDK installer changes from #342 are not copied over the newer installer
already in the candidate. This integration adds one MEASURED product result,
ANR03, and makes the existing AN00 controls available only in the separate
upstream diagnostic suite. Neither is a PASS or a waiver for a product failure.
Its own exact-head CI must validate the combination before acceptance; the
standalone operation-evidence run is not proof for the integrated head.
