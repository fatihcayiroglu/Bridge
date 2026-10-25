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
It also asserts that each address edit replaced the entire field before submit.
All original checks and deadlines remain. These additions expose the failing
phase without publishing actual/expected values; they are not an app fix or
proof that the earlier intermittent failure has been resolved.
