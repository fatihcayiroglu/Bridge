# Native startup and software keyboard acceptance

On #433 source `a94c60e8`, native CI 40174170872 failed on both platforms.
Android reached the real React Native/Fabric JS application but could not find
the initial address field. iOS reached the connection-input phase, then exited
65 with an unclassified error. The original failure artifacts are preserved.
No ANR, startup, focus or lifecycle root cause is established by those reports.

This follow-up first strengthens observation and acceptance without changing
the application or retrying a failed journey:

- Android checks that the runner screen is on and keyguard is unlocked before
  starting the app. A failure reports only booleans and fixed enum categories
  for foreground ownership, heading/input presence and accessible-label shape.
  Unknown values remain unknown. No package name, UI text, path or exception
  message is emitted. It does not wake, unlock or re-foreground a failed app.
- The evidence formatter is test-only Kotlin, shared between JVM and device
  test source sets. Four new JVM controls cover private inputs, known/unknown
  states and missing observations; CI must execute all **six** JVM tests,
  including the original two build-policy tests. The real Android journey
  remains separately required with expected count one.
- iOS explicitly enables the simulator software keyboard. Every address edit
  must observe that keyboard and, within five seconds, a hittable field fully
  above it. A complete-value assertion precedes submission. All original
  liveness, insecure-address, unavailable-server and resident-resume checks
  remain. This proves keyboard usability only when the native journey passes.
- Fixed action markers distinguish focus, keyboard visibility/geometry, clear,
  type, verify, submit and liveness. The failure classifier emits known UIKit
  input-event reason codes without any raw exception or actual/expected value.

Local Python/syntax checks cannot prove Kotlin compilation, iOS geometry or
device startup. Real Gradle/JVM, emulator and Xcode/XCUITest checks are required
on the new source. Any failing acceptance stays failed. A later passing run
does not retroactively explain or erase the earlier failures. This is a draft
preview stack, with no production cutover or permission to merge #375.
