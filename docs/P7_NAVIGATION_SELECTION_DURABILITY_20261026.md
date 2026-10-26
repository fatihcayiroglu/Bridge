# Preserve an authenticated channel reselection across reload

#472 and #473's fixed lifecycle experiments both failed at their first cold-start
restoration. Their processes, resumed Activities and DevTools endpoints remained
present; neither observation diagnosed the historical FocusEvent ANR or DL02 crash.
#472 also had separate product media failures. These first failures remain retained.

## Reproduced client defect

The real ChannelListManager component may select a fallback while the principal
is unknown. It correctly writes no user preference then. Once authentication
identifies the owner, clicking that already-selected text channel returns early
without saving the owner's choice. A remount can therefore fall back to another
channel instead of restoring that explicit selection.

The component regression failed against unchanged #473 (null preference after
the explicit selection). The correction saves an authenticated text choice before
the same-channel return, retaining the existing no-duplicate-selection/join behavior.
The test then remounts the real component with a different first channel and
requires the original choice to restore.

Only channels confirmed by the current authorized API list are remembered. A
newly created channel can be selected before its list refresh; its preference is
saved when that response confirms it. Unknown principals and unconfirmed channel
records do not create preferences. A pre-auth fallback cannot overwrite an owner's
existing remembered choice. Existing server permissions, list filtering and
restoration intersection still determine access; preferences do not grant access.

## Correct the experiment's native focus source

Android 14's WindowManager `windows` subcommand dumps WindowState records;
DisplayContent.dump owns `mCurrentFocus`. The full `dumpsys window` includes both
display focus and windows/dialogs. Source: Android 14 r1
[WindowManagerService](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/services/core/java/com/android/server/wm/WindowManagerService.java#6990),
[DisplayContent](https://android.googlesource.com/platform/frameworks/base/+/refs/tags/android-14.0.0_r1/services/core/java/com/android/server/wm/DisplayContent.java#3619).

EX01 now reads that full dump, bounded to one million characters; excess input
remains partial and fails. A fixture with WindowState-only output reproduces the
old missing-focus result and fails the positive focus assertion before correction.
Exact component focus is still required: there is no null-to-PASS fallback.

Separate session/channel failure stages and fixed UI/preference-match booleans
make another failure distinguishable without exporting IDs, user names, storage
keys, paths, URLs, logs or raw errors. No original native assertion, timeout,
product PASS count or first-failure stopping rule is changed.

## Acceptance limits

The component regression proves a client navigation defect and its correction.
It does not establish that this caused either retained EX01 failure; the original
artifacts lacked the necessary UI/preference snapshot. Real exact-head Android
must exercise the corrected product and focus probe. A later green cannot erase
the earlier product media failures or diagnose #209. Physical device acceptance
and all remaining #321/P7 criteria remain open. #375 is not merged.
