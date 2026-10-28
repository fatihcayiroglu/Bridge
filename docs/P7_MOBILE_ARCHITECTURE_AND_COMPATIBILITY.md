# Owner decision: React Native mobile; P7 OPEN

On 2026-10-28 the owner selected React Native / Expo as the intended long-term
architecture for Android and iOS. Stop new Capacitor-specific mobile features.
Preserve the existing Capacitor application and all user data until verified
feature parity and a safe, lossless migration path exist. Keep web and Electron.
No automatic migration, uninstall, deletion, deployment or production merge is
authorized by this decision.

## Mandatory acceptance matrix

Android: determine the actual built minimum, test it, Android 15 / API 35,
Android 16 / API 36, Android 17 / API 37 where available, plus physical Samsung,
Xiaomi and Pixel devices where available. The current Expo 57 / React Native
configuration indicates API 24 (Android 7) as the **build floor**, not verified
product support. The workflow reads the APK's own `sdkVersion` and refuses a
changed floor rather than silently reclassifying it.

iOS: retain the framework's iOS 16.4+ deployment floor, test 16.4, intermediate
major versions 17 / 18 / 26, every supported installed runtime, the latest
available version, and actual iPhone hardware where available. The workflow
records the built app's `MinimumOSVersion`, runtime inventory and actual version.
Latest **installed** is not proof of the latest Apple release; unavailable
versions remain NOT EXECUTED and require an appropriate runner/runtime/device.

For every OS/device the full acceptance requirements are authentication and
account switching, messaging, voice/video, uploads, notifications/background
behavior, encrypted offline storage/crash recovery, security and measured
startup/responsiveness. A Pixel-shaped emulator is not a physical Pixel,
Samsung or Xiaomi device. Framework support or a successful build does not
establish Bridge compatibility.

## This increment's scope and evidence

The existing native SecureStore / SQLCipher process-termination acceptance now
runs separately on API 24/35/36/37 with fail-fast disabled. Each artifact names
its API and retains the exact head, APK metadata, runtime API, binary SHA-256,
first-failure logs/screenshots and original fixture verdict. A missing system
image fails its job and leaves compatibility NOT EXECUTED, never PASS.

On iOS the same built app runs on each available supported installed simulator
runtime using a new owned simulator. Each has independent native markers,
screenshots, logs, binary identity and verdict; no failing sample is retried or
overwritten by a later OS sample. Missing 16.4/intermediate versions and physical
devices are explicitly NOT EXECUTED in the runtime plan.

These are **native protected-storage and encrypted-recovery** tests only. Each
report leaves all other feature rows and overall product compatibility NOT
EXECUTED. Debug Metro times never satisfy release startup targets (<1 s meaningful
UI, <2 s usability). The system-browser authentication journey remains a
separate #544 gate; backend/Chromium evidence cannot replace it.

At authoring time the newly expanded matrix has NOT EXECUTED. The nine report
integrity tests are unit contracts, not mobile compatibility evidence. This
document does not claim support for any additional OS version.

## Migration and remaining work

Keep independent parity gates for protected credentials, account/server-scoped
SQLCipher history/outbox, stable ackIds after restart, attachments, notification
permissions/deep links, background recovery and calls. Design a versioned,
encrypted export/import with interruption recovery, integrity checks, rollback
and user review before moving existing Capacitor data. Do not reuse or erase an
existing database directory to make a native test pass.

Verified App/Universal Links stay off pending real owner-controlled domain and
release identities. Physical vendor devices, unavailable OS runtimes, release
performance, reinstall policy and migration remain mandatory open requirements.
P7, #209 and #416 remain open.
