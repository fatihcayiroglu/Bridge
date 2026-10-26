# Android #209: bounded lifecycle reproduction after product acceptance

The FocusEvent ANR and #468's unexpected DL02 crash remain unresolved. #470
calibrated the Java-crash diagnostic path on a real emulator. This experiment
uses that path and the existing ANR event/dialog parsers against the product.
It does not change product lifecycle code or claim a root cause.

## Fixed experiment

EX01 runs on the API 34 emulator after all original product verdicts, PD01
exit checkpoints, ANR03 timeline collection and ANR02 postmortem collection.
CR00's intentional crash remains afterward. Product PASS counts are unchanged.

After a separate signed-out-baseline/login preparation, three cycles each run:

1. Force-stop and cold-launch MainActivity; restore the session/channel.
2. HOME for 20 seconds, then resume. Require Android's HOT launch classification
   and the same PID before/after backgrounding.
3. Force-stop and cold-launch the existing channel deep link, alternating the
   target channel to prevent stale selected-channel state passing.

Each cold launch must be COLD and keep its initial process through UI rendering
and a further two-second observation. Every phase requires the expected channel,
visible app, DOM window focus, exact MainActivity native window focus, no observed
fresh OS ANR, and a readable window/dialog probe. Existing attach/UI/channel
deadlines remain 60/45/30 seconds; an additional 100-second action budget bounds
each preparation/phase. Diagnostic ADB calls reuse the existing 12-second bound.
Aborted action sequencing cannot issue a subsequent launch after a delayed shell
response. An in-flight native/DevTools request is not claimed to be cancelled.

Stop at the **first** failure, retain its stage and collect bounded, process/OS/
clock-correlated Java-crash and window/event evidence before another launch.
The experiment has no retries. Preparation and unavailable clock/evidence are
failures. An experiment failure fails the native job independently of product
totals; the job summary also rejects missing/incomplete/inconsistent EX01 data.

## Evidence and limits

Kernel PSI and load/memory fallback values are collected before/after phases;
they are observations of pressure, not a resource-starvation diagnosis or an
artificial contention trial. The existing product pressure collector shares the
same bounded projection and no longer publishes its redundant raw PID field.
Kernel load/memory fallback values are not PSI measurements.

Only fixed phase/stage/status categories, booleans, bounded counts and kernel
values leave the experiment. Raw exceptions, URLs, channels, classes, stacks,
PIDs, package names and device timestamps are excluded from its summary. Existing
#470 and ANR parsers retain their privacy and freshness boundaries. Event-log
coverage remains **observed-only**, or unknown/partial when unreadable/truncated;
zero observed events is not a completeness claim. The device-clock window is at
most 120 seconds. Slow failure diagnostics may exceed it and must remain unknown.

This does not yet vary WebView versions, inject CPU/memory load, or diagnose a
renderer/native main-thread stall. A fatal-ANR native trace for a new EX01 failure
is not automatically collected: preserving the first process/window state takes
precedence over launching another Activity. That remains an explicit evidence gap.
A passing experiment is nonreproduction, not resolution of #209. Physical-device
acceptance remains unverified; #209/#321 stay open and #375 remains unmerged.

## Local validation

- Original parser contracts plus new executable experiment tests: 122/122,
  zero skipped/todo. Original 101 test names and all 90 original journey assertion
  lines retained; the CR00 CLI fixture now supplies an independently valid EX01.
- Tests cover every one of the nine possible first-failure positions, missing
  clocks, preparation failure, PID replacement/unknown PID, false COLD/HOT claims,
  wrong channel/focus, OS ANR, partial observation, strict summary, deadline/late
  continuation, privacy, event freshness and pressure-read failures.
- Deliberately dropping PID stability, HOT classification or ANR rejection each
  fails its relevant negative control; original source restored afterward.
- Local tests drive injected IO, not an Android emulator. Real Android evidence
  and exact-head full Quality Gate are required and reported separately in the PR.
