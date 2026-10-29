# Native foreground visibility — do not confuse renderer paint with a shown window

Base #588abe977bfa4dfcdf60108dfe0e26a335ae853f773, preserving all original histories. P7 OPEN, no main merge/deploy.

## Exact failure and qualification correction

Firstabe977bf native run40850585767/job123368765214 FAILed before authentication atAUTH_WINDOW_FOCUS/NATIVE_WINDOW_FOCUS. Document complete anddocument.hasFocus=true, but BrowserWindow.isVisible=false andisFocused=false. Credentials were not entered,0login requests,0scenarios executed.295component+12executor tests and actual production builds passed separately. Artifact12886563945 SHA256849955bb24d25a01ea1f6c30cde37f313ecadc4e75fc50fc8187851078b5f085 downloaded/verified.

Earlier first58404e54d5d and588f43bb657 could execute packaged renderer/HTTPS/history assertions while not checking native visibility/focus. Retain their measured data and workflow statuses, but do NOT qualify them as foreground native GUI/performance acceptance. Current failure does not establish every historical window was hidden; those heads lacked the necessary evidence. Native foreground metrics require a new verified candidate.

## Product correction, not harness showing a hidden window

main.ts created the saved-server main window withshow:false and relied solely on rendererready-to-show before calling show. A normal foreground launch now presents the native main window immediately with its existing dark background; explicit--background remains hidden, including afterready-to-show. The harness does not callshow or weaken focused/visible/document-focus checks; it still activates/focuses the actual app and makes one ordinary click before requiring realHTTPS auth200.

Electron documents that an initially hidden BrowserWindow can have a visible renderer, and recommends immediate native presentation with backgroundColor for complex pages: https://www.electronjs.org/docs/latest/api/browser-window . This supports treating renderer visibility and native-window visibility separately. Whyready-to-show was not sufficient in the observed run is not fully established; no originalWayland416/Android209 causal fix is claimed.

## Verification

Real-main.ts regression before correction:52PASS/1FAIL/0SKIP (foreground show option false). After correction:53/53PASS, zero skipped, including background launch, actual main-module sandbox/deep-link/notification/navigation tests. Electron production typecheck and compilation PASS. No dependency/security/preload/server/mobile change. NativeCI must build/install the actual changed ASAR and require its window genuinely visible and focused; pending, not PASS. This does not establish meaningful UI<1s/usability<2s, physical devices, gaming/SFU, browser-find/accessibility/rich-media parity or fullP7 closure. Keep draft.


First product correctioncd941eccac76e741c21deaacc92283262764c799 run40852341698/job123374669194 passed295component+53Electron+12executor tests/build and actualnativefocused:true/visible:true/documentfocus:true. It stillFAILed AUTH_RESPONSE_UNAVAILABLE:0global and0targetpointer/click events,0login requests/0scenarios. The visibility correction is observed, but input delivery is not fixed. Artifact12888410603 SHA25624968b5a60f76ae75fcb9b63074bd4575aa92acc70e4ed6a886ceaabe6459fc6 verified. Same-headD240852341760/job123374669177 PASS361unit+15realPG16/Redis,0FAIL/0SKIP; artifact12887747939 SHA256fbef2f58b6cb2d8203bef3d4af59a51c42bc2cea6f39b3b6bf8d33d43d5df429 verified.

The original disposable session hadXvfb/dbus but no window manager. Add an actualOpenbox owner in the same X11 session and require EWMH manager readiness before launching the packaged app. Preserve allnativefocus/visibility/auth/click/security assertions and fixed observation windows. Export only the closedWMname into provenance, keep privateWMlogs out of artifacts and stop only the created process. This is a controlled infrastructure candidate, not proof of the missing input cause or a Wayland substitute. No force click, handler/API invocation, fake auth response or timeout increase. Earlier failures remain.
