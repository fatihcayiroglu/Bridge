# Android 15–17 compatibility evidence (API 35 / 36 / 37)

**Status: not yet certified.** This is an additive emulator-smoke experiment and
does **not** replace the required Android 14 (API34) full product journey CI,
does not change any gate's verdict, and does not close Android issue #209.

## Exact experiment

Workflow: `.github/workflows/android-api35-37-compat.yml`.

- Builds the current Bridge debug APK using the documented Capacitor setup,
  curated Android overlay and Gradle.
- Reads **the compiled APK's** targetSdkVersion and fails if it is below API36
  (Google Play's 2026 requirement). This is independent of the OS on which
  the APK is installed.
- Boots Google APIs x86_64 emulators at API35 (Android 15), API36 (Android 16),
  and API37 (Android 17), without substituting other OS images.
- For Android 17, requires Google APIs system-image **revision >= 5** due to
  Android's documented Play-services certification bug on older API37 images.
- Installs the exact built debug APK; verifies the actual device API and full
  boot; cold-launches `com.bridge.app.debug`; confirms it remains alive; presses
  HOME; confirms process survival; relaunches; and verifies the same PID
  persists on short background/warm resume.
- Reports individual real failures and keeps CI red if any required smoke
  step cannot run. The matrix is `fail-fast: false` so one OS cannot conceal
  another. The standalone workflow is **not configured as a required
  branch-protection check** and will not quietly downgrade API34 required CI.

## What this does *not* prove

A smoke PASS does **not** establish that login, Socket.IO communication, full
messaging journeys, push notifications, microphone/camera permissions,
audio/video, file uploads, WebView CDP attachment, deep links, ANR01/ANR03,
L01's **20-second** background journey or physical devices pass.

This workflow has a short background cycle and does not start the Bridge
server or run the P7 product journey suite. It deliberately has no results
that can be relabeled as full Android compatibility.

Next acceptance work: run the strict full product journey suite on API35/36/37
with an appropriately configured server and database; then validate physical
devices and store-signing workflows. Keep #209 open until FocusEvent ANR
mechanism, mitigation and repeatable evidence are established. Do not rerun
red product tests to seek a green sample, hide skips or silence actual failures.

## Relevant Android platform facts

- 2026 Google Play submission target: API36+ for new phone apps and updates.
- Android 17 API37 Google APIs image revision 5+ recommended for working GMS:
  https://developer.android.com/studio/run/emulator-troubleshooting
- Google Play target API policy:
  https://developer.android.com/google/play/requirements/target-sdk
