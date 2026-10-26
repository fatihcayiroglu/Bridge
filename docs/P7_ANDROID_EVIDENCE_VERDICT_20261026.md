# Android evidence summary must fail closed

On parent #472 (`379a7d2d`), the summary CLI returned **exit 0** for a missing
file, malformed JSON and `{}`, even while saying the run was a failure. This
is a reproduced reporter defect. It does not establish that any retained CI run
with valid evidence was falsely green: the upstream journey command and its
existing failures still gate the job independently.

The new verdict validates the actual evidence before reporting success:

- Explicit expected suite; native evidence category; valid exact commit, matched
  to `GITHUB_SHA` when running in Actions. Two matching stale calibration/product
  artifacts cannot borrow a PASS on a different workflow head.
- Nonempty bounded results, unique valid IDs, known statuses; any FAIL/SKIPPED
  fails. The 36 mandatory product checks must be PASS and the 7 measurements
  MEASURED. An independent acceptance inventory prevents omission or measurement
  inflation. Adding a product check requires updating the inventory.
- Declared totals must equal computed totals. Forging a smaller consistent
  inventory still fails. Upstream WebView controls remain a separate explicit
  profile; their failures are not turned into measurements or product passes.
- Existing separate CR00/EX01 gates remain. Their successful fixtures cannot
  override a failed, omitted, unknown, stale or unreadable product report.

The CLI sets a nonzero exit and prints only a fixed failure code when validation
fails. Parser/read errors do not leak file contents or arbitrary exceptions.
No acceptance threshold, product journey, Android source or workflow trigger
changes. The parent experiment is preserved unchanged on this child branch.

Regression: missing/malformed/empty evidence test failed against unchanged
parent (exit 0 instead of 1). Corrected full parser/experiment/verdict suite:
130/130, zero skips/todo. Negative cases cover each mandatory check, measurements,
duplicates, totals, dry-run evidence, stale commits and CLI failure propagation.
Deliberately dropping CLI failure propagation or the independent inventory each
fails its relevant test. Local fixtures are unit evidence only. Exact-head native
Android and full Quality Gate must be reported separately after execution.

This fixes reporting integrity, not the FocusEvent ANR or unexpected DL02 crash.
#209/#321 stay open. #375 is not merged and no production deployment is authorized.
