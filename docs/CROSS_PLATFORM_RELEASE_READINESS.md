# Five-platform release readiness — evidence ledger

**Last reviewed: 2026-10-12. This is a readiness checklist, not a release certification.**

Bridge has distinct runtime surfaces: Electron desktop on Windows/Linux/macOS;
Capacitor mobile on Android/iOS; and a separate, remotely deployed Bridge server.
A successful build is not a production/user-device success. A test that never ran,
was cancelled, was skipped, or ran at an older commit **must not be counted as PASS**.

## Evidence definitions

| Category | Meaning | What it cannot establish |
|---|---|---|
| SOURCE / STATIC | Code contract, TypeScript, security lint | Executable starts or feature works |
| BUILD | Installable package/binary built by CI | Successful installation, first run, or update |
| AUTOMATED / NATIVE | Built app launched on target OS and passed stated assertions | Physical-device variation, user experience, real peripherals |
| AUTOMATED / EMULATOR or SIMULATOR | Real mobile binary tested in emulator/simulator | Real radio, APNs/FCM delivery, real camera/mic, handset hardware |
| REAL DEVICE | Signed-off test on named device + OS build | Other devices or release/store signing |
| RELEASE | Signed/notarized release + installation + update/rollback proof | Independent security assessment or all real networks |
| UNVERIFIED / BLOCKED / FAIL | A missing, unavailable, or failing check | **Never** a pass |

Release blockers must be listed by **exact commit SHA + run ID**, not by an
unqualified “all green”. GitHub path filters can omit workflows; their absence
is not evidence of success.

## Automated gates

| Platform | Pipeline / test | Current scope |
|---|---|---|
| Windows 11 x64 | `desktop-native-gates.yml` Windows job | Windows-native Jest, TypeScript compile, unsigned NSIS package, packaged `Bridge.exe` first-run Chromium renderer at local `static/connect.html` (on CI completion only) |
| Linux x64 | `desktop-native-gates.yml` Linux job | Electron Jest/compile; unsigned AppImage and installed DEB; Chromium sandbox; real X11/Xvfb window and Weston **native Wayland** xdg-toplevel smoke |
| macOS x64 / arm64 | `desktop-native-gates.yml` macOS job | Jest/compile; unsigned DMG/ZIP and architecture verification; packaged **x64** first-run renderer on macos-14 |
| Android | `mobile-android.yml` | Debug APK; Android emulator journeys (lifecycle, login, network, deep links, permission sheets, WebView). Emulator FAIL fails CI |
| iOS | `mobile-ios.yml` | Simulator Debug .app build, native launch and stated WKWebView/deep-link checks (not full browser driving) |
| Cross-platform core | `quality-gate.yml` | Security, strict TypeScript/Svelte, integration, web/E2E, Windows Electron contracts |

The desktop native workflow now triggers on `client/**` as well as `electron/**`.
The Electron shell loads the hosted Bridge UI; desktop changes are not limited
to edits under `electron/`. Desktop-native jobs remain separate from mobile
emulator and simulator evidence. A source change that triggers only one workflow
does **not** make the untriggered platforms green.

### Confirmed example: 2026-10-12 (not a blanket latest-release pass)

- UI roles [PR #201](https://github.com/fatihcayiroglu/Bridge/pull/201)
  head `5cbe22a24dec77467063bb7232b0d774a45ba17f`:
  [iOS simulator run 38237208519](https://github.com/fatihcayiroglu/Bridge/actions/runs/38237208519) **PASS**;
  [Android run 38237208601](https://github.com/fatihcayiroglu/Bridge/actions/runs/38237208601)
  APK **PASS** but emulator **FAIL** with DL02 and downstream failures after
  lost WebView/Playwright attachment. L01/L02 hot/background resume passed;
  the underlying native vs automation failure needs separate proof. This must
  not be relabelled as a mobile pass. On that head, the initial client test run
  failed because a legacy assertion expected “Profile roles” after renaming to
  “Roles”; PR subsequent commit updates that assertion and needs fresh CI.
- An iOS simulator pass does not prove APNs, background push, cell handoff,
  human audio, or actual iPhone behavior.
- At this review, the new Windows/desktop expansion in this PR has **no green
  exact-head native result yet**. Even after passing, binaries are unsigned CI
  artifacts, not release-candidate signed installers.

## Real-device release blockers — a signed test report is required

The tester records *date, Bridge commit/release, hardware model, OS/build,
network, tested user accounts, PASS/FAIL/BLOCKED, and sanitized evidence links*.
No account secrets, raw logs containing tokens, or private message content.

### Windows 11 (Intel/AMD)

- Install **signed** NSIS as a non-admin user; launch, login, reconnect and
  reconnect after process death; verify installed app identity and bridge://.
- Test update, rollback/uninstall, auto-update feed signature and Windows
  SmartScreen presentation; shutdown leaves no persistent orphan processes.
- Real mic/camera/screen share and audio devices, notifications, multi-monitor,
  Windows permission toggles, sleep/resume and IPv4/IPv6/TURN.

### Linux (at least Ubuntu and one other supported distribution)

- Install DEB and AppImage on **real machines**; validate X11 and Wayland
  sessions separately, Chromium sandbox not bypassed, file picker and portal,
  screen-sharing portal under Wayland, keyring, tray and notifications.
- Confirm permissions, mic/audio output, updates/rollback, logout and second
  user session. Headless Weston success is **not** a physical desktop pass.

### macOS (Intel and Apple Silicon)

- Signed/notarized DMG installed on both architectures; Gatekeeper accepts
  launch, login, tray, protocol links, updates and rollback. Separate tests
  for macOS Screen Recording/Microphone/Camera permissions, TCC re-prompt after
  revoke, sleep/resume, media, and headset switching.
- A macos-14 **x64** renderer smoke and arm64 package file presence alone
  cannot certify an Apple Silicon first run.

### Android (at least two real devices/API levels)

- Signed release APK/AAB installed; compare warm/cold launch, process death,
  L01–L04, deep links DL01–DL04, back/IME, rotation, real permission sheets,
  offline/outbox consistency and large channel performance.
- FCM push received while the app is backgrounded/force-stopped; test Wi-Fi
  <-> cellular handoff, carrier NAT, battery optimisation, mic/camera capture,
  wired/Bluetooth routing and real upload file picker.

### iOS (at least two physical iPhones)

- Signed TestFlight distribution, provisioning, native WKWebView auth/session
  restoration and app-owned URL scheme; background/force-close launch and
  deep link flows; APNs delivery and permission changes.
- Test cellular/Wi-Fi transitions, real microphone/camera/screen share
  restrictions, audio routing/CallKit where applicable, storage pressure and
  crash recovery. An iOS simulator smoke cannot certify these.

## Global release gate

Do not mark five-platform production-ready until:

1. Every required exact-head automated check finishes PASS (not pending,
   cancelled or skipped); failing cases have independently reproduced fixes.
2. Linux/X11+Wayland, macOS x64+arm64, and Windows package boot gates succeed
   on current head; mobile emulator/simulator tests succeed without skip.
3. Signed Windows, macOS, Android, and iOS release provisioning and install
   evidence exists; native release/update/rollback is proven.
4. Real-device checklist above is completed; human media and accessibility
   checks are signed off across real machines and separate networks.
5. Credentials, external push provider, app-store approval, and operational
   infrastructure evidence is recorded (or marked explicitly BLOCKED).

See `docs/P4_MOBILE_NATIVE.md`, `docs/MEDIA_RELIABILITY.md`,
`docs/VOICE_HUMAN_VERIFICATION.md`, and `docs/PRODUCTION_10_10_CHECKLIST.md`
for detailed product-specific external tests.
