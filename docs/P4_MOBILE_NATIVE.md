# Mobile / native maturity (P4)

P4 makes the Capacitor apps (Android, iOS) behave correctly across the things a phone does to an
app — launch, background, process death, network loss, permission sheets, push, deep links, the
keyboard, rotation — and records what was proved **where**. Every result carries exactly one
evidence category, and categories are never merged into one claim:

| Category | Meaning |
|---|---|
| **AUTOMATED / EMULATOR** | Android 14 emulator (API 34, x86_64, `google_apis`, WebView 113) in CI, driving the real debug APK |
| **AUTOMATED / SIMULATOR** | iOS simulator in CI (macOS 15 runner), the real Debug `.app` |
| **UNIT / INTEGRATION** | vitest/jest against the real modules, real PostgreSQL where stated |
| **REAL DEVICE** | a physical phone — **none was available in P4** |
| **REAL NETWORK** | a carrier/Wi-Fi network — **none; network faults are injected on a runner-owned proxy** |
| **EXTERNAL / UNVERIFIED** | needs hardware, credentials or networks this project does not have |

Every failure is classified as exactly one of: **product defect**, **test/harness defect**,
**environment/infra defect**, **known documented limitation**, **external/unverified**. SKIPPED and
MEASURED results are never counted as PASS.

## Environment capability

| Capability | Available | Where |
|---|---|---|
| Build the Android app the documented way (`setup.js` → `cap add android` → curated overlay → `cap sync` → Gradle) | yes | CI `Mobile Android` › APK job (AGP 8.13, Gradle 8.14.3, compile/target SDK 36, min SDK 24, Java 21) |
| Run the APK on an Android emulator with KVM | yes | CI `Mobile Android` › emulator job (`reactivecircus/android-emulator-runner`, Pixel 6 profile) |
| Drive the app's WebView, OS lifecycle, permissions, input | yes | Playwright `_android` over adb (WebView via CDP; OS via `am`, `pm`, `svc`, `input`, `uiautomator`, `dumpsys`) |
| Cut / delay the app's network path | yes | runner-owned TCP proxy between `adb reverse` and the server (`adb reverse` bypasses the emulated radio, so `svc wifi/data disable` alone is not an outage) |
| Build the iOS app and launch it on a simulator | yes | CI `Mobile iOS` (`cap add ios` → curated overlay → `xcodebuild` Debug iphonesimulator → `simctl`) |
| Drive the iOS WKWebView | **no** | no WebDriver for it here; the iOS smoke asserts what the OS and the app's own console prove |
| Physical Android / iOS devices | **no** | EXTERNAL / UNVERIFIED |
| Firebase project / APNs key (real push delivery) | **no** | EXTERNAL / UNVERIFIED |
| Real mobile networks (handover Wi-Fi ↔ cellular, captive portals, carrier NAT) | **no** | EXTERNAL / UNVERIFIED |
| Bluetooth / wired headsets, earpiece routing, CallKit | **no** | EXTERNAL / UNVERIFIED |
| macOS locally | **no** | the iOS path runs only in CI |

## Architecture (as measured, not as documented)

- The app is a Capacitor 8 shell around the web client. Android serves it from `https://localhost`,
  iOS from `capacitor://localhost`; `BRIDGE_API_URL` is baked into `www/js/bridge-config.js` by
  `mobile/scripts/setup.js`. REST goes through CapacitorHttp/CapacitorCookies; Socket.IO uses the
  WebView's WebSocket.
- `android/` and `ios/` are generated per machine (`.gitignore`). The product's native layer is
  curated in `mobile/android/` and `mobile/ios/` and applied by `apply-android-overlay.js` /
  `apply-ios-overlay.js` (the iOS one is new in P4 — before it, nothing applied `mobile/ios/`).
- `mobile/capacitor-bridge.ts` (compiled to `mobile/capacitor-bridge.js`) is the only native↔web
  seam: push, deep links, haptics, status bar, biometrics, camera, share. It makes **no** server
  requests of its own; the app's authenticated client (`apiFetch`: API root, CSRF, refresh) owns
  every server call.

## Baseline — current main (`Mobile Android` run 36747816271, commit `5ccee55`, no product change)

AUTOMATED / EMULATOR — Android 14 (API 34), `sdk_gphone64_x86_64`, WebView 113.0.5672.136.

| Check | Result | Class | Root cause / note |
|---|---|---|---|
| A01 cold launch → auth screen | PASS (6214 ms) | | |
| A02 login in the WebView | PASS | | |
| A03 server + channel list, channel opens | PASS | | |
| M01 send from the composer, persisted | PASS | | |
| M02 live message from another user | PASS (308 ms) | | |
| L01 background 20 s, message arrives, foreground shows it | PASS (HOT resume 485 ms) | | |
| L02 background 75 s (past the socket ping timeout) | PASS | | |
| L03 process killed in background → relaunch restores session + missed message | PASS (2767 ms) | | |
| L04 force-stop → cold relaunch restores the session | PASS (2136 ms) | | |
| N01 offline: banner, message held, delivered once | **FAIL** | test/harness defect | "message reached the server while offline": `adb reverse` bypasses the emulated radio, so `svc wifi/data disable` never cut the app's path. N02's PASS in this run is therefore **not evidence** either |
| D01 DM from another user reaches the DM list and opens | **FAIL** | environment/infra defect | the job did not run the migration chain; DM history answered 500 (`column "readAt" does not exist`) |
| K01 Android back closes an open dialog | PASS | | |
| DL01 warm `bridge://channel/<id>` | **FAIL** | product defect | P4-07 below: nothing consumed the link |
| DL02 cold `bridge://channel/<id>` | **FAIL** | product defect | P4-07 below (after that fix, a second defect: P4-14) |
| DL03 link to an inaccessible channel reveals nothing | PASS | | |
| P01 microphone denied in the real sheet → voice join tells the user | **FAIL** | test/harness defect | the sheet was looked up by one package name; Android 14 emulator images ship `com.google.android.permissioncontroller` |
| P03 microphone granted → outbound audio RTP | PASS (35 packets) | | |
| P04 voice while backgrounded 20 s | MEASURED | | the OS kept capture alive (`silenced:false`, packets 62 → 1128) |
| P02 notification permission readable without prompting | PASS (`prompt`) | | |
| P05 notification permission granted, build without Firebase | **FAIL** | product defect | P4-18 below: the process died on launch |
| UI01 landscape | **FAIL** | test/harness defect | cascade of P05's crash (page closed) |
| PERF01 memory (PSS) | MEASURED (null) | test/harness defect | cascade of P05's crash |

Totals: 14 PASS, 7 FAIL, 0 SKIPPED, 2 MEASURED.

## Defect log

Common fields unless a row says otherwise — **environment** AUTOMATED / EMULATOR (CI `Mobile
Android`, Android 14 API 34 `sdk_gphone64_x86_64`, WebView 113.0.5672.136, debug APK of the
commit named); **network** runner-owned proxy in front of the server (no real radio). Every fix is
on PR fatihcayiroglu/Bridge#112; CI run, merge SHA and the post-merge gate are recorded in
[Closure](#closure). Unit/integration evidence is listed as such and never as device evidence.

### Product defects

| ID | Area | Observed (repro) | Expected | Root cause | Fix (commit) | Negative control | Regression tests |
|---|---|---|---|---|---|---|---|
| P4-01 | session | Log out, then replay the refresh cookie: `/api/refresh` → **200** (real Chromium) | 401, session revoked | the cookie is path-scoped to `/api/refresh`; the client posted to `/api/logout` with `redirect:'error'`, the server's 307 was never followed (under the service worker: a synthetic 503) | client posts to `/api/refresh/logout` (`5dd1d1e`) | real-browser probe 200 before; unit tests 3/4 fail on old code | `client/tests/p4-session-logout.test.ts`, `e2e/tests/session-logout.spec.ts` (4, real browser + server) |
| P4-02 | session | no logout control anywhere (0 in the shell, 0 in six settings tabs) | visible logout; logout everywhere | never built | Settings sidebar + Security › Sessions: Log out, two-step Log out on all devices (`5dd1d1e`) | e2e: control absent before | `e2e/tests/session-logout.spec.ts` |
| P4-03 | push / session | after logout, logout-all or password change the device kept receiving pushes | delivery ends with the session | nothing removed native tokens or Web Push subscriptions | logout names this installation's targets (removed only for the refresh session's own user); logout-all and password change remove all (`5dd1d1e`) | server tests 7/12 fail on old code | `server/tests/p4-session-push-revocation.test.ts` |
| P4-04 | push | a second account registering on the same phone: `duplicate key value violates unique constraint "native_push_tokens_token_key"` (real PostgreSQL); the first account kept receiving | the token moves to the registering account | upsert keyed per user+platform on a globally UNIQUE token | token moves; up to 10 installations per user; unregister can name one token (`5dd1d1e`) | real PG 3/3 fail on old code | `server/tests/pg-integration/native-push-token-ownership.pgtest.ts`, repository tests |
| P4-05 | push | a native device could never register for push | registration reaches the server | the bridge posted to a **relative** URL (the app's own `https://localhost`) and without `X-CSRF-Token` (403) | the bridge only reports the token; the app registers it through `apiFetch` (`5dd1d1e`) | bridge tests 4/6 fail on old code | `mobile/tests/push-session.test.js`, `client/tests/p4-native-push.test.ts` |
| P4-06 | push | the native app had no way to turn push on | a contextual opt-in that says its state | no UI | Notifications › native push card (prompt only on tap; unavailable/denied/failed stated) (`fcd2aba`) | — (absence) | `client/tests/p4-native-push-settings.test.ts` |
| P4-07 | deep links | `bridge://channel/<id>` opened the app and did nothing, warm and cold (baseline DL01/DL02 FAIL) | the channel opens, through permission-checked lookups | `bridge:deeplink` had no listener | `client/js/core/native-deeplink.ts`: channel/server/invite/DM/group-DM routing via the server's APIs; cold-start queue (`ee322e2`) | emulator DL01 FAIL → PASS | `client/tests/p4-native-deeplink.test.ts` (14); emulator DL01, DL03 |
| P4-08 | push | tapping a notification called globals that do not exist | the conversation opens | dead `bridge:navigate` handler | taps feed the same permission-checked router (`ee322e2`) | bridge tests | `mobile/tests/push-session.test.js` |
| P4-09 | push | DMs and group DMs never reached a phone whose app was not connected | a push, batched | `dm:send`/`gdm:send` emitted on sockets only | `server/lib/dmPush.ts` (3 s debounce, 15 s cap; E2E bodies never leave the server) (`fcd2aba`) | handler tests 2/10 fail on old code | `server/tests/p4-dm-push.test.ts` |
| P4-10 | push | FCM payload named icon `ic_stat_bridge` (absent) and channel `bridge_default` (never created): default icon, filed under "Miscellaneous" | the app's icon, a Bridge channel | names never matched the app | payload `ic_notification` + brand colour; the bridge creates `bridge_default` at launch; manifest default channel (`69063fc`) | contract 3/4 fail on old payload | `mobile/tests/push-payload-contract.test.js`; emulator **PN01** (channel exists on the device) |
| P4-11 | push | a push received while the app was visible showed a second, system notification | one notification | foreground pushes re-posted locally | skipped while visible (`ee322e2`) | bridge test | `mobile/tests/push-session.test.js` |
| P4-12 | security | `bridge://auth/callback?token=…` was accepted: any app or web page could hand the app a session | a session never enters through a link | legacy handler | removed; the parser rejects it (`ee322e2`) | old test pinned acceptance | `mobile/tests/capacitor-bridge.test.js`, `client/tests/p4-native-deeplink.test.ts` |
| P4-13 | iOS | an app built the documented way had **no** `NSMicrophoneUsageDescription` (iOS terminates the app on first microphone use), no `bridge://` scheme, version 1.0 (1) | the curated native layer is applied | nothing applied `mobile/ios/` | `apply-ios-overlay.js` merges the curated keys; npm scripts and CI apply it (`b9da742`) | template negative-control test | `mobile/tests/ios-overlay.test.js`; iOS simulator **I01** |
| P4-14 | deep links | cold link: target server already selected, its channel list in flight → "not available" toast, first channel wins | the linked channel | the empty in-flight list was read as "no such channel" | the intent waits for that authorized list (`4b5f341`) | unit test fails on old code | `client/tests/channel-load.test.ts` |
| P4-15 | push | (introduced on this branch by P4-03, caught before merge) sign-out on an FCM-less Android build called `unregister()` → `FirebaseMessaging.getInstance()` throws on the plugin thread → process death | sign-out leaves the app running | unguarded call | only where native push is available (`69063fc`) | bridge tests 2/17 fail on the pre-fix bridge | `mobile/tests/push-session.test.js`; emulator **LO01** |
| P4-16 | push / web | a signed-out browser kept its Web Push subscription | unsubscribed on logout | not bound to the session | `bindWebPushToSession()` (`5dd1d1e`) | unit test | `client/tests/p4-session-logout.test.ts` |
| P4-17 | deep links | (after P4-14) cold link still landed on `#general`: the router asked for the server list during the boot load; `loadServers` returned at once and the list was **empty** | the linked channel | the registry's `loadServers` was not awaitable | a queued load resolves after the reload it queued; the router bounds its wait (`aa23336`) | ServerSwitcher tests 2/2 fail on old code; Chromium cold-start probe: `#general` before, target after | `client/tests/server-rail.test.ts`; emulator **DL02** |
| P4-18 | push | build without `google-services.json` (the self-hosted default): granting notifications killed the app at launch (`IllegalStateException: Default FirebaseApp is not initialized`) | the app runs; push says "unavailable" | `register()` without Firebase | native `BridgePushSupport.status()`; `register()` only where FCM is configured (`5dd1d1e`) | emulator **P05** FAIL (baseline) → PASS | `mobile/tests/push-session.test.js`; emulator P05 |
| P4-19 | voice | denying the microphone in the real OS sheet showed "No microphone found — joined muted" | "permission denied" — a different fix for the user | the SFU path mapped every `getUserMedia` error to one text | shared `core/mic-error.ts` for P2P and SFU (`fb60280`) | unit test fails on old code | `client/tests/webrtc-sfu.test.ts`; emulator **P01** text |
| P4-20 | iOS deep links | **AUTOMATED / SIMULATOR**: `simctl openurl bridge://channel/<id>` → OSStatus −10814 while a unique control scheme on the same build opened; `com.apple.Bridge` (Apple's Watch app) declares `bridge` | a link reaches Bridge on an iPhone | iOS gives a scheme claimed by a system app to that app | `com.bridge.app://` (reverse-DNS) on iOS and Android, parsed like `bridge://` (kept for existing links) (`579ac5d`) | contract test 3/3 fail on the previous manifest/plist/bridge | `mobile/tests/deep-link-scheme.test.js`; iOS **I04**, Android **DL04** |
| P4-21 | layout | **AUTOMATED / BROWSER, emulated insets** (the page declares `viewport-fit=cover`): 390×844 with a 47 px top inset — header search/"more" at y 7–39, first server/member entries at y 34–38; 844×390 — composer and user panel in the 21 px home-indicator band, server rail under a 47 px cutout | nothing interactive under the system bars | the shell padded only the bottom inset | shell padding for every inset, drawers start below the top inset, the wide layout keeps the bottom band clear (`23d0257`) | `e2e/tests/safe-area.spec.ts` 3/3 fail on the previous CSS | the same spec, in the PR gate |
| P4-22 | layout | 844×390 landscape, no insets: Settings (min-height 480 px, centred) sat above the screen — close button at y −28 | the dialog fits; close is tappable | fixed minimum height | short viewports get a full-safe-area dialog with a scrolling tab list (`23d0257`) | as P4-21 | as P4-21 |

### Test / harness and environment defects

| ID | Class | Observed | Root cause | Fix |
|---|---|---|---|---|
| H-01 | environment/infra | emulator job: `Cannot find module 'typescript'` before the emulator booted | root toolchain not installed | install root deps (`5ccee55`) |
| H-02 | environment/infra | D01: DM history 500 `column "readAt" does not exist` | migration chain not run in the job | schema + migrations step (`5dd1d1e`) |
| H-03 | test/harness | N01 "message reached the server while offline" | `adb reverse` bypasses the emulated radio; `svc wifi/data disable` is not an outage | runner-owned proxy that cuts / delays the path (`5dd1d1e`) |
| H-04 | test/harness | P01 "permission sheet did not appear" | looked up by one package; the image ships `com.google.android.permissioncontroller` | match both controllers by uiautomator dump (`5dd1d1e`) |
| H-05 | test/harness | UI01 / PERF01 failed after P05's crash | the crash-path check ran mid-suite | crash-path checks last (`5dd1d1e`) |
| H-06 | test/harness | P01 `androidDevice.tap: Please install Android driver apk` | Playwright's driver APK is not installed | real touches via `input tap` at the node's bounds (`77c95ad`) |
| H-07 | test/harness | UI02 `page.tap: The page does not support tap` | page without `hasTouch` | `input tap` at the element's on-screen position (`77c95ad`) |
| H-08 | test/harness | L03 "process gone" timeout | `am kill` issued before the launcher was in front | wait for the launcher, retry, record the method (`77c95ad`); run 6: `am kill`, 1 try |
| H-09 | test/harness | mobile jest: npm-script test failed | exact-string match broke when the iOS overlay was added | requires every overlay before `cap sync` (`69063fc`) |
| H-10 | test/harness | iOS I02–I04 FAIL with an empty console | fixed 25 s waits; the runner's simulator took ~2 min to launch the app | poll launch and readiness, time-limit every command, print diagnostics (`f668bb5`, `726529a`) |
| H-11 | test/harness | V02 never passed | required **every** peer connection connected; the receive transport stays `new` alone in a call (P03: `["connected","new"]`) | judge the send transport: connected + audio leaving + SFU bytes returning on the selected ICE pair (`a7b7d0a`) |
| H-12 | test/harness | PERF02 "channel … in list" timeout | channel inserted by SQL; the loaded app never learns of it | create the channel via the API, bulk-seed only history (`a7b7d0a`) |
| H-13 | test/harness | iOS I02 "pid=''" although the app ran (launchctl listed it) | `--console-pty` printed the `<bundle>: <pid>` line late | pid from `launchctl list` (`579ac5d`) |
| H-14 | test/harness (latent) | — (no wrong result yet) | the runner labelled every run AUTOMATED / EMULATOR; a phone's run would have been mislabelled | category derived from `ro.kernel.qemu` / `ro.boot.qemu`; `ANDROID_SERIAL` (`85afecb`) |
| H-15 | test/harness | PERF02 (second run): channel created via the API still not in the open list | by design the server does not broadcast channel metadata (limitation below) | reload the app after seeding (`85afecb`) |
| H-16 | test/harness | PERF02 (run 8): 2000 seeded, only 50 ever rendered | scrolled `.msg-list`; the list scrolls inside `#messages-area`, where the client listens (reproduced in Chromium: `.msg-list` 50→50, `#messages-area` 50→100→150…) | scroll `#messages-area` |
| H-17 | test/harness | iOS I04 (run on `ebe72ba`): `openurl com.bridge.app://…` succeeded, no dispatch line | the console was relayed through `--console-pty`; Swift `print` is block-buffered off a terminal (the pid line and the ready line also arrived minutes late) | app stdout/stderr straight to files with `NSUnbufferedIO=YES`; terminate with `simctl terminate` |

## Known documented limitations

- **No foreground service for calls (Android).** P04 measured on the emulator that microphone
  capture continues for 60 s in the background (`silenced:false`, packets 81 → 3169), but Bridge
  starts no `microphone`-type foreground service. Real devices with aggressive power management may
  stop or kill a backgrounded call; that is **EXTERNAL / UNVERIFIED**. Adding a call foreground
  service (and the matching `FOREGROUND_SERVICE_MICROPHONE` declaration) is the proposed follow-up;
  it is not added blind, without a device to prove it.
- **A channel created elsewhere does not appear in already-open clients** until their next channel-list
  load (switching servers, reconnect, restart). By design (`server/routes/servers/channels.ts`): channel
  metadata is not broadcast to the server room because private-channel visibility is per requester.
  Reproduced in Chromium (10 s, no socket frame). Proposed follow-up, privacy-safe: a content-free
  "channels changed" signal on which every client reloads its *own* authorised list. Not changed in
  P4: it alters a deliberate security decision and is not mobile-specific.
- **No CallKit / ConnectionService.** Incoming-call UI, lock-screen controls and Bluetooth headset
  call buttons are not integrated; `voip` is deliberately not declared on iOS (App Review requires
  PushKit + CallKit for it).
- **Long channels are not virtualised** (P3 decision, re-measured in P4): see "Long channel" above —
  +13 MB and no extra stall up to 300 messages; ~1 s worst stall past 1,500 on the emulator.
  Revisit only with real-device evidence.
- **MEDIA-11** (audio-first admission experiment `f561254`) stays closed; nothing in P4 reproduced
  it on a device or network, and no safer fix was found.
- **DM edit/delete** were out of P4 scope and remain as before.
- **The emulator's audio is not a microphone** (silence; `audioLevel` ≈ 0.0001): P03 proves outbound
  RTP, not voice quality.

## EXTERNAL / UNVERIFIED

Nothing below is claimed as passing anywhere in this document.

| Item | Why it cannot be verified here | What would verify it |
|---|---|---|
| Any physical Android or iOS device | none available | the journeys in `e2e/android/android-journeys.mjs` against a USB device (`ANDROID_SERIAL`), the iOS smoke on a device |
| FCM / APNs delivery to a device (background, locked, killed app) | no Firebase project, no APNs key, no Play-services device | a configured project + device; P4 only proves the payload names, channel, token lifecycle and server fan-out |
| iOS push registration and notification taps | simulator has no APNs | a device with an APNs key |
| Wi-Fi ↔ cellular handover, captive portals, carrier NAT, real packet loss | no radio; faults are injected on a TCP proxy | a phone on real networks |
| Audio routing: earpiece / speaker / Bluetooth / wired, interruptions (phone call, alarm) | emulator/simulator have no audio hardware routing | a device |
| Background voice survival under OEM power management | emulator is permissive | a range of devices |
| Real camera quality, rotation of a real sensor | emulated camera | a device |
| iOS WKWebView journeys beyond launch and deep-link dispatch | no WebDriver for the iOS WebView here | XCUITest or Appium on macOS |
| App-store builds (signing, release minification) | out of P4 scope | release pipeline |

## Evidence matrix by workstream

Columns never merge: a PASS in one column says nothing about another. "—" = no evidence of that
kind exists. Android physical and iOS physical are empty because no device was available.

| # | Workstream | Android emulator (CI) | iOS simulator (CI) | Unit / integration | Android physical | iOS physical |
|---|---|---|---|---|---|---|
| 1 | Native baseline | APK via the documented path; A01 cold launch | `xcodebuild` Debug; I01 built bundle carries mic/camera strings, `bridge://`, version | overlay tests (Android, iOS) | — | — |
| 2 | Real devices | — | — | — | EXTERNAL | EXTERNAL |
| 3 | App lifecycle | L01 background, L02 past ping timeout, L03 process death, L04 force-stop | I02 cold launch alive | — | — | — |
| 4 | Network transitions | N01 offline hold + single delivery, N02 resync, N03 400 ms latency (MEASURED), V02 voice after a 10 s loss | — | — | — | — |
| 5 | Voice / audio routing | P03 outbound audio RTP, P04 background capture (MEASURED), V03 leave closes media | — | voice suites | routing EXTERNAL | routing EXTERNAL |
| 6 | Camera | P06 deny via the real sheet, P07 outbound video RTP | — | — | — | — |
| 7 | Permissions | P01 mic deny, P03 grant, P06/P07 camera, P02 notification state without prompt | I01 usage strings | — | — | — |
| 8 | Push | PN01 channel on the device, P05 FCM-less launch, LO01 FCM-less sign-out | — | token lifecycle, DM push, payload contract, revocation (server + real PG) | delivery EXTERNAL | delivery EXTERNAL |
| 9 | Deep links | DL01 warm, DL02 cold, DL03 inaccessible channel hidden, DL04 `com.bridge.app://` | I04 `com.bridge.app://` dispatch, I06 `bridge://` owned by `com.apple.Bridge` | router tests (14), parser rejects tokens | — | — |
| 10 | File / photo | F01 system picker → upload → file message | — | composer/upload suites | — | — |
| 11 | Layout / input | UI01 landscape, UI02 software keyboard, K01 back key | — | safe-area e2e (Chromium, emulated insets; PR gate) | — | — |
| 12 | Performance | A01/L-series timings, PERF01 PSS, PERF02 long channel (MEASURED) | I05 (MEASURED) | — | — | — |
| 13 | Session / security | LO01; deep links never carry a session | — | logout revocation (unit + real browser e2e), token ownership (real PG) | — | — |
| 14 | Error / recovery UX | P01 (denied ≠ missing), P06 camera denial, N01 offline banner | — | mic error mapping | — | — |
| 15 | Mobile CI | `Mobile Android` (APK + emulator) | `Mobile iOS` (build + simulator) | mobile jest in the APK job | — | — |

## Producing REAL DEVICE evidence (what P4 could not do)

The Android journeys run unchanged on a USB-connected phone; the runner derives the evidence
category from the device (`ro.kernel.qemu` / `ro.boot.qemu`), so a phone's run is labelled
**AUTOMATED / REAL DEVICE** and an emulator's never is.

1. Build the debug APK as the workflow does (`BRIDGE_API_URL=http://localhost:3000 node
   mobile/scripts/setup.js`, `npx cap add android`, `node mobile/scripts/apply-android-overlay.js`,
   `npx cap sync android`, `./gradlew assembleDebug`).
2. Start the server as in the workflow, with `MEDIASOUP_ANNOUNCED_IP=<the host's LAN address>`
   (`10.0.2.2` only exists inside the emulator; media is UDP and cannot ride `adb reverse`) and
   the phone on the same network.
3. Enable USB debugging, then `APK_PATH=<apk> ANDROID_SERIAL=<serial> bash
   e2e/android/run-emulator-journeys.sh`.

Network checks (N-series, V02) cut the app's server path at the runner's proxy and switch the
phone's Wi-Fi/data off; on a phone that is a real radio change, so those results become REAL DEVICE
+ REAL NETWORK evidence only when run that way.

## Measurements (AUTOMATED / EMULATOR — not device numbers)

Android 14 emulator on a CI runner (x86_64, KVM, no GPU); run-to-run variance is large, so the
spread is shown. These are **not** real-device performance figures (EXTERNAL / UNVERIFIED).

| Measure | run 2 (baseline) | run 4 | run 6 | run 7 | run 8 | run 9 |
|---|---|---|---|---|---|---|
| Cold launch → auth screen (`am start -W` TotalTime, A01) | 6214 ms | 7652 ms | 8709 ms | 6987 ms | 7010 ms | 7377 ms |
| HOT resume after 20 s in background (L01) | 485 ms | 699 ms | 384 ms | 450 ms | 250 ms | 578 ms |
| Relaunch after process death (L03) | 2767 ms | — | 3887 ms | 5097 ms | 2253 ms | 3632 ms |
| Cold relaunch after force-stop (L04) | 2136 ms | 2647 ms | 2495 ms | 2237 ms | 1929 ms | 2028 ms |
| Offline → reconnect: held message delivered (N01) | invalid (H-03) | 2915 ms | 4012 ms | 3544 ms | 1148 ms | 5200 ms |
| Missed message visible after 30 s offline (N02) | invalid (H-03) | 5314 ms | 2171 ms | 1640 ms | 649 ms | 1135 ms |
| Composer send → persisted at 400 ms one-way latency (N03), copies | — | 1595 ms, 1 | 1570 ms, 1 | 1675 ms, 1 | 1794 ms, 1 | 1957 ms, 1 |
| Voice recovery after a 10 s network loss (V02) | — | — | invalid (H-11) | 6556 ms | 6529 ms | 6525 ms |
| Background microphone capture after 20/60 s (P04) | not silenced (20 s) | not silenced (60 s) | not silenced (60 s) | not silenced (60 s) | not silenced (60 s) | not silenced (60 s) |
| Memory after the journeys, total PSS (PERF01) | null (H-05) | 104780 KB | 112398 KB | 111622 KB | 113633 KB | 165132 KB (after PERF02's 2000 messages) |

### Long channel (PERF02, run 9 — AUTOMATED / EMULATOR)

2000 messages seeded in one channel; the app opens it and scrolls `#messages-area` to the top
until all history is loaded (50 per page).

| Messages rendered | DOM nodes | Total PSS | Long tasks (cumulative) | Longest task |
|---|---|---|---|---|
| 50 (open) | 2,148 | 111.5 MB | 3 | 588 ms |
| 300 | 10,151 | 124.4 MB | 8 | 588 ms |
| 550 | 18,151 | 132.7 MB | 13 | 588 ms |
| 1,050 | 34,151 | 150.8 MB | 23 | 588 ms |
| 1,550 | 50,151 | 161.7 MB | 34 | 713 ms |
| 2,000 | 64,550 | 165.4 MB | 51 | 1,029 ms |

About 32 DOM nodes per message and one long task per 50-message page. Up to ~1,000 messages the
worst stall equals the channel-open stall (588 ms); past ~1,500 the worst stall grows to ~1 s.
(`performance.memory` stays at 11 MB in this WebView — not a usable signal; PSS is.)
**Decision (closure item 17): virtualisation is not added.** Reaching 1,500+ rendered messages
takes ~30 deliberate "load older" pages; the everyday range (≤ 300) costs +13 MB and no stall worse
than opening the channel. This is an emulator on a CI runner, not a phone; it is retained as a
known limitation with this measured rationale, to be revisited only with real-device evidence.

iOS simulator (separate workflow, AUTOMATED / SIMULATOR): launch command → WKWebView bridge ready
(I05) took 157 s (`Mobile iOS` run 2) and 204 s (run 3). That time is dominated by the runner's
first simulator boot; it is **not** an app launch time.

<!-- P4-RESULTS -->
