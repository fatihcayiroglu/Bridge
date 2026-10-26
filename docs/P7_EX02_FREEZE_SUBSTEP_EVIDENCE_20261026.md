# EX02: retain the failing protocol substep

At `dd29310bc7a8406a54e720b446db52787940875e`, Android run
[40322004974](https://github.com/fatihcayiroglu/Bridge/actions/runs/40322004974)
passed 36 product checks and CR00, but failed the first EX01 cold-start channel
assertion. Pre-stop preference/UI matched; earliest boot's stored channel did
not. Strict native focus passed. The independent EX02 comparison then verified
its unfrozen baseline but failed at the outer `freeze` stage, with no frozen
snapshot, freeze-event confirmation or post-control boot measurement.

The existing controller discarded inner step names: CDP session creation,
DOMStorage enablement, listener registration, freeze command and freeze-event
evaluation all collapsed to `freeze`. Consequently the artifact cannot show
which command failed, or whether the controller exhausted its deadline. Do not
claim an unsupported CDP method, a missing event or a storage root cause from
that artifact.

Pass a diagnostic wrapper around the existing abort-aware callback context.
Record only an allowlisted `substep` (unknown names become `other`) and a
`deadlineExceeded` boolean read from the controller's actual abort signal.
Reset the substep on each outer operation and check abort before recording a
later callback. Raw errors, protocol payloads and arbitrary names stay private.
Cleanup remains independently bounded and retains its existing PASS/FAIL flag.

Two new regressions failed before this change: 11 passed / 2 failed / 0 skipped
in the focused controller suite. Afterward all 154 Android Node tests passed,
zero failed/skipped/todo. Tests include private/unknown substep names, ordinary
errors versus an actual timer abort, and a stalled command completing after
the reported failure without advancing to another command or cold launch.

The CDP commands, freeze-event requirement, storage baseline requirements,
100-second action budget, cleanup budget, control eligibility, EX01 assertions
and failure exit status are unchanged. This is diagnostic attribution, not a
freeze strategy or persistence fix. Real Android calibration and exact-head CI
remain required. Keep the draft stack unmerged, #209/#321 open and #375 unmerged.
