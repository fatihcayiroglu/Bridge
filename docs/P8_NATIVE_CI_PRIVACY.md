# Native CI failure evidence

Native build logs are private diagnostic inputs. A filename, test name, account
identifier or credential can occur without a recognizable prefix. Pattern
redaction, retaining basenames, and retaining the first/last part of an error
message cannot establish that text is safe to publish.

`summarize_xcode_failure.py` emits only fixed category, reason and artifact-kind
codes, a validated nonzero exit status, and bounded numeric marker counts. No
log substring is copied to its output. Recognized failures retain actionable
codes such as `duplicate-output`, `test-iterations-minimum`, `not-hittable` and
`element-not-found`. Unknown failures remain `unclassified`.

At most four markers are described. Reads are limited to 16,384 characters at
a time and an 8 Mi-character scan budget; `scan-truncated=true` explicitly marks
an oversized line or incomplete scan. A classification is not a complete root
cause analysis. The report always says FAIL. The workflow preserves Xcode's
original nonzero exit status even if the diagnostic itself cannot be written.

The native result verifier also emits fixed failure categories. Missing,
malformed, failed, skipped or incomplete results still fail. Parser and file
exceptions cannot publish a traceback, runner path or report filename. Backend
startup diagnostics no longer copy arbitrary event-shaped strings from logs.
Raw Xcode, backend and Metro logs remain excluded from uploaded artifacts.

## Native artifact boundary

The previous Android upload selected entire JUnit and instrumentation output
directories, including raw logcat, protobufs, XML failure text and system-out.
The successful Xcode path also uploaded its whole structured summary. Two
artifact-selection regressions failed on that baseline using synthetic private
report/log contents. Historical artifacts are preserved, not rewritten.

Native artifacts now use an explicit file allowlist. `verify_native_results.py`
still reads and validates the actual original reports; its optional `--output`
writes only PASS with verified executed/failed/skipped counts, or FAIL with a
fixed category. Failure does not fabricate an executed count. A failed Android
startup may include the test-owned enum/boolean observation after a bounded
private scan; unknown fields, arbitrary failure text and system-out are never
copied. Original report directories and both raw Xcode summaries stay private.
The source commit and dependency locks remain uploaded.

Always-run publication steps evaluate both Android suites even if one fails,
write separate evidence, and fail if either gate fails. The original build,
emulator and Xcode test steps keep their strict gates and exit behavior. Missing,
malformed, skipped, incomplete or contradictory reports cannot pass. In
particular, a nonempty or malformed Xcode `testFailures` field is rejected even
if numeric counters falsely claim zero failures. A regression reproduced that
previous acceptance defect for all four contradictory field shapes.

Validation: 54 Python tests passed, zero skips, including real CLI runs and an
execution of the workflow's actual publication block with each native suite
failing in turn. YAML, all Bash run blocks and diff checks passed. These are
reporting/privacy controls, not new device acceptance. Fresh source-head native
CI and inspection of the actual uploaded artifacts remain required. The app,
network adapter, Kotlin/Swift journeys, expected test counts and coverage
thresholds are unchanged by this artifact correction.

The subsequent parent window/keyboard observation adds one native JVM case:
both original validation and artifact publication now require seven JVM tests.
The artifact parser accepts its new fixed system/alert codes and older records;
raw alert titles remain private. Failure publication also selects the actual
private failed-XCTest summary when present instead of incorrectly looking only
for the success-path file. A shell regression reproduced that missing-source
classification and now verifies an explicit failed-report result. These changes
do not alter the original native test failure or publish failure text.

Regression tests use synthetic sensitive filenames, paths, identifiers, URL
schemes, credential spellings, terminal controls, malformed input and CLI
errors. Shell tests stub failed child processes to verify diagnostic behavior;
these are unit tests and do not substitute for the real PostgreSQL-backed
Android instrumentation and iOS XCUITest workflow.

Parent #430 and #431 native CI evidence is preserved, including earlier failed
attempts. A new diagnostic change requires its own source-head CI result. The
source SHA artifact, committed CocoaPods lock and deployment-mode check remain
in force. No mobile assertion, test count, retry policy or coverage threshold is
relaxed. This work grants no production integration or release approval.

The first #433 run on `c1d5e715` (40172295301) passed contracts and Android but
failed iOS with exit 65 and one unclassified error marker. Its source-SHA and
failure artifact are preserved; the cause is unverified. The next diagnostic
revision records only literal native journey stages and known assertion codes.
It also reports a fixed OS application-state enum at lifecycle assertions;
the original boolean results and deadlines are unchanged.
It also asserts that each address edit replaced the entire field before submit.
All original checks and deadlines remain. These additions expose the failing
phase without publishing actual/expected values; they are not an app fix or
proof that the earlier intermittent failure has been resolved.
