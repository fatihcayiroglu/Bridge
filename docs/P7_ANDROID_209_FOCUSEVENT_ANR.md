# Android #209 — FocusEvent ANRs (exit reason 6): evidence, hypotheses, measurements

**2026-10-20 · cause UNPROVEN · AUTOMATED / EMULATOR evidence only · #209 stays OPEN**

Tracking issue: [#209](https://github.com/fatihcayiroglu/Bridge/issues/209). The FontsProvider stable reference and its DEPENDENCY DIED kills (reason 12) are a separate mechanism, documented in [`P7_ANDROID_209_ROOT_CAUSE.md`](P7_ANDROID_209_ROOT_CAUSE.md). Nothing here attributes the ANRs to it.

Labels: **[F]** fact read from a CI log or source file; **[I]** inference from facts; **UNPROVEN** means no direct evidence.

## 1. What was recorded

- **[F]** About 11 of about 82 completed API 34 emulator runs or attempts recorded an OS ANR for the Bridge package; about 71 recorded none (issue #209 and PR #238 / #322 / #332 comments, plus the job logs that were still available).
- **[F]** Every classified ANR is "Input dispatching timed out … Waited ~5000 ms for FocusEvent(hasFocus=true)".
- **[F]** They cluster at cold starts (A01, CS01) and at L01, about 30–80 s after `sys.boot_completed`, under heavy guest load (1-minute load 21–28 on 2 vCPUs; CPU PSI some avg10 up to 88 where captured).
- **[F]** Two main-thread stacks exist:
  - run 38632246276: main thread in `ThreadedRenderer.nSyncAndDrawFrame`, waiting on RenderThread;
  - run 38696869775: main thread in a synchronous `IInputManager.getInputDevice` binder call from `InputManagerGlobal$InputDeviceListenerDelegate`.

  Each is one snapshot taken after the 5 s timeout plus dump latency.
- **[F]** Image: API 34 Google APIs x86_64, WebView 113.0.5672.136, `-gpu swiftshader_indirect`, 2 vCPUs.
- **[F]** Head `56364d4` (run 39397040745, no ANR): the pass-free main-thread heartbeat window 1.0–1.5 s after the first page load ran no main-thread message for about 450 ms. The main thread is fully busy for at least that long during startup; the cause is not attributed.

## 2. AOSP 14 facts that shape the reading (read in source)

- **[F]** `BaseErrorDialog` registers for `ACTION_CLOSE_SYSTEM_DIALOGS` and calls `closeDialog()`. `AppNotRespondingDialog.closeDialog()` sends `FORCE_CLOSE`, which calls `killAppAtUsersRequest`. `AppErrors.killAppAtUserRequestLocked` records `REASON_ANR` with the kill reason "user request after error".
- **[F]** A HOME key press broadcasts `ACTION_CLOSE_SYSTEM_DIALOGS`. **An ANR dialog that is still on screen when L01 presses HOME therefore ends the app with exit reason 6**, whenever the ANR itself happened.
- **[F]** "ANR in" is logged only after the stack dump. The dialog is posted after that. `handleDismissAnrDialogs`, run when input resumes, dismisses only a dialog that already exists (`ProcessErrorStateRecord`, `AppErrors`, `ActivityManagerService`).

  **[I]** So an app that recovers while its ANR is still being dumped can be left with a dialog that nothing dismisses.

## 3. Hypotheses (ranked; none proven)

| | Hypothesis | Status | Fix owner |
|---|---|---|---|
| H0 | Reason-6 exits at L01 / P04 are the HOME press closing a dialog left by an **earlier** ANR, usually at a cold start | INFERRED from the timing of 6 runs; the AOSP step is now source-verified (§2) | harness reading (the stall itself is H1–H6) |
| H1 | Main thread waits in `syncAndDrawFrame` on a RenderThread slowed by host GPU emulation (`swiftshader_indirect`) | one direct stack | environment / HWUI / WebView |
| H2 | Synchronous binder from the main thread (WebView's input-device listener → `getInputDevice`) into a saturated system_server | one direct stack | WebView / platform |
| H3 | Guest CPU saturation on 2 vCPUs early after boot starves the main thread, or the thread it waits on | circumstantial | CI environment |
| H4 | App-owned main-thread work right after the first frame (Capacitor bridge, plugins, Bridge Java) | **UNPROVEN** (the 450 ms busy window is consistent with it but does not identify an owner) | app |
| H5 | A runtime-wide ART pause (GC, suspend-all) | **UNPROVEN**; explicit GCs in the release pass pause all threads ≤ 0.2 ms in total (run 39397040745) | mixed |
| H6 | Harness work at cold start (CDP attach, adb dumpsys sampling) loads the WebView UI thread, which is the main thread | **UNPROVEN** | harness |
| H7 | The app freezer during L01's 20 s background | contradicted: the reason-6 exits come 0.08–2.3 s after HOME, before any freezer debounce | — |
| H8 | FontsProvider / EmojiCompat | not attributed: FD02 saw 0 references on the PID that later had a FocusEvent ANR (run 39038117703) | — |

H1, H2 and H3 can hold together: H3 would be the common cause and H1/H2 how it shows.

## 4. New measurements (this change; measurement only, no verdict changes)

**ANR03 (product suite, MEASURED).** The system event log's own timeline for the Bridge process:
- `am_anr`, `am_kill`, `am_proc_died` and `am_proc_start` lines, read at the PD01 checkpoints and at the end so the rotating buffer cannot drop early ones;
- device-clock offsets from the journey start, using toybox `date +%s.%N` when available, otherwise whole seconds;
- the check that was running when each ANR was declared and when its process was killed;
- events before the journey origin or after the observation end are excluded and counted separately; reused numeric PIDs are separated by process incarnation;
- **coverage is never certified complete**: `observed-only` means only observed rows are reported, `partial` flags a missing process start, capped rows or a failed checkpoint read, and `unknown` covers no Bridge events in the observation window. An empty or foreign-only log is **not** proof of zero ANRs;
- the kill's reason as a fixed class (`user-request-after-error`, `background-anr`, `force-stop`, …);
- ANR-dialog samples (from `dumpsys window windows`; booleans only) after startup, **right before L01's HOME press**, and at the end.

**AN00 / AN00-L (diagnostic suite, MEASURED).** A debug-only Activity blocks its own main thread once, for 7 s / 20 s, right after its first traversal, and the harness sends a key event during the stall. Recorded:
- whether and when the ANR is declared;
- whether the dialog is still up 4 s after the stall ended;
- what L01's HOME press then does: the kill reason and the exit reason.

The stall start is when the harness saw the control's `stall-begin` marker (polled every 250 ms), so `anrAfterStallBeganMs` is good to about ±0.5 s.

## 5. What each result would mean

| Result | Points to |
|---|---|
| ANR03: a reason-6 exit at L01 whose `am_anr` is ≥ 10 s earlier, in A01/CS01, with `killReasonClass=user-request-after-error`, and `before-L01-home` shows `anrDialogs ≥ 1` | **H0 confirmed** for that run: the L01 FAIL is a consequence of an earlier cold-start ANR, which is the defect to explain |
| ANR03: `am_anr` < 5 s before the L01 kill, or kill reason `background-anr` | H0 refuted for that run: the ANR happened during L01 |
| AN00: dialog still up after the 7 s stall ended, and HOME → `user-request-after-error` / exit reason 6 | the lingering-dialog race happens on this image |
| AN00-L: dialog gone after recovery, process alive after HOME | dismissal on resume works when the dialog was already shown; only the race leaves one behind |
| ANR03 step attribution concentrated in A01/CS01 within ~5–15 s of a cold start | the stall is a cold-start phenomenon (H1/H3/H4/H6); separating those needs main-thread state at the stall (next step) |

## 6. Not done here

- **Main-thread state for a recovered ANR.** ANR02 sees only fatal ANRs. Next candidates, in order:
  - `dumpsys dropbox --print data_app_anr`, classified to enums;
  - a debug main-thread stall sampler;
  - Perfetto `sched`/`binder`/`input` traces around cold starts, reduced to trace_processor summaries (no raw trace upload).
- **The GPU-mode A/B** (`swiftshader_indirect` vs `swangle_indirect`) and a post-boot settle gate: each changes one environment variable and needs about 30 runs per arm to be conclusive for a rare event.
- **Physical devices:** none available. No device result exists or is implied.
