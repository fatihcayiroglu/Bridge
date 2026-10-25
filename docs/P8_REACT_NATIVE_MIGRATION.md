# P8 React Native migration

The owner approved starting P8 alongside unfinished P7 on 2026-10-25. Android
and iOS will share a React Native New Architecture application. Web remains
Svelte 5; desktop remains Electron and Svelte. The backend and its security
protocols remain authoritative. All migration stages below belong to **P8**.

## Current implementation and integration boundary

`apps/mobile` is a separate native preview with application identifier
`com.bridge.nativepreview`. It cannot replace the existing `com.bridge.app`
installation or its local data. The Capacitor application in `mobile/` is retained.
There is no production cutover, signing credential, deployment, or release here.

The P8 foundation branch starts at dependency-security PR #413 (`7634d61d`),
whose changes relative to main are dependency manifests and locks. Its draft PR
targets that branch. It does **not** inherit the unapproved P7 integration
candidate #375. Integrating #413 or P8 into main still requires review and the
owner's authorization. Auto-merge is not enabled.

The native application renders a real accessible server-address form, validates
the address, calls Bridge's existing public `/api/health/live` endpoint, and
shows verification or a bounded public error. Address changes cancel obsolete
probes, including late body parsing and transports that ignore cancellation. An
eight-second deadline remains authoritative. No credential or conversation is
persisted by this milestone.

`packages/core` provides framework-independent TypeScript. Server-origin policy
was extracted from Electron rather than copied into a second implementation.
Electron consumes the same policy, public liveness contract, and deadline.
Native URL and IDNA handling uses maintained URL/UTS46 libraries; it does not
invent a parser. Plain HTTP is limited to loopback, with an explicit Android
emulator exception in development builds only. Production remote origins require
HTTPS. Credentials embedded in addresses are rejected.

The native public probe requests omitted credentials and rejected redirects and
also checks the final response URL. Some native fetch implementations follow
redirects internally: the final-URL check does **not** prove that an intermediate
request was prevented. This transport must not be repurposed for authenticated
requests. Native cookie isolation and redirect handling are requirements before
adding authenticated transport.

## Reproducible toolchain

Versions were checked against published package metadata and the actual RN
template: React Native 0.88.0, React 19.3.0, community CLI 20.2.0, TypeScript
6.0.3, Node 24 (CI 24.20.0). The native application has an independent npm lock;
the dependency-free core is also a root workspace. This avoids introducing
React/Metro into the Svelte dependency workspace. No postinstall compilation is
required by the production root install.

Android uses the template's SDK 37/build-tools 37.0.0, target 36, minimum 24,
NDK 27.1.12297006, Kotlin 2.2.0, and Gradle 9.4.1 with its verified distribution
checksum. CI uses JDK 21 and an API 35 x86_64 emulator. Other ABIs and physical
devices remain unverified. Hermes and the New Architecture are enabled.

iOS has minimum deployment target 15.1. The installed React Native 0.88 build
requires **Xcode 26+**: CI uses `macos-26`, asserts the Xcode major version,
and has completed a real simulator XCUITest. CocoaPods 1.17.0 and xcodeproj
1.28.1 are the pinned compatible pair; the Ruby lock covers macOS and Linux.
The template's older xcodeproj constraint was incompatible with current
CocoaPods and was removed. The **67,707-byte generated `ios/Podfile.lock`**
from successful source `c83efd26` is committed in stacked draft #431.
`bundle exec pod install --deployment` and an unchanged-lock check passed on
exact head `e84b25d9`; this proves the debug CI dependency lock, **not** a
signed release or stability across all future runner images.

## Commands and evidence categories

From the repository root:

```sh
npm ci
npm run test:core
npm run lint --workspace=@bridge/core -- --max-warnings=0
npm ci --prefix electron
npm test --prefix electron -- --runInBand
npm run compile --prefix electron
npm ci --prefix apps/mobile
cd apps/mobile
npm test -- --coverage --json --outputFile=jest-results.json
node ../../scripts/require-no-skipped-tests.js jest-results.json
npm run typecheck
npm run lint -- --max-warnings=0
npm run bundle:android
npm run bundle:ios
```

Local evidence: 9 core tests, 20 native component/adapter tests, 51 existing
Electron tests, and 4 adversarial native-result gate tests passed. Core coverage
is 100% lines/functions and 95.71% branches. Native TypeScript coverage is 100%
lines/statements/functions/branches. Every coverage threshold remains at least
90%. These results are unit/contract evidence, **not native device acceptance**.

The `P8 React Native` workflow adds actual Gradle/JVM tests and Android
UiAutomator, plus Xcode simulator builds and native XCUITest. Both journeys
operate the native form against the real Bridge backend with disposable
PostgreSQL and Redis. They check positive liveness, address canonicalization,
insecure-address rejection, unavailable-server errors, and resident resume.
Android additionally checks the target PID remains unchanged. iOS resident UI
state is tested; no iOS same-PID claim is made. Neither journey uses WebView or
JavaScript execution to operate the app. Debug builds use Metro and are not
self-contained release artifacts. Build-policy JVM tests do not prove runtime
feature parity. Native reports fail closed for missing tests, skips, expected
failures, or failures; CI does not automatically retry failed test journeys.


### First exact-head native acceptance (2026-10-25)

- [#430 run 40152872023](https://github.com/fatihcayiroglu/Bridge/actions/runs/40152872023), source `c83efd26`: **all three required P8 jobs SUCCESS**. Actual Android emulator instrumentation **1/1** and JVM tests **2/2** passed; iOS real simulator XCUITest **1/1** passed. Every native test summary reported **0 failed, 0 skipped**.
- [#431 run 40154150915](https://github.com/fatihcayiroglu/Bridge/actions/runs/40154150915), source `e84b25d9`: **all three jobs SUCCESS again**, same strict native counts. This run additionally proved the committed CocoaPods graph under `pod install --deployment` with no lockfile modification. The exact generated lock originated from #430's passing iOS artifact and was not hand-edited.
- Both PRs remain **DRAFT** and stacked on #429, which itself depends on review of security-pin #413. They are not merged, signed or released. The native journey tests **one server connection flow**, not full Android/iOS application parity; prior Capacitor failures, physical-device gaps, background delivery and production upgrade risks remain open. Keep unsuccessful historical runs visible.

## Verifiable acceptance ledger

The existing web username/password precheck is shared through
`@bridge/core/registration`; browser, Node and native contract consumers use
one implementation. See `P8_SHARED_REGISTRATION_CONTRACT.md` for tests and its
boundary. Native registration and authenticated sessions remain open below.

| Stage | Requirement | State / evidence required |
| --- | --- | --- |
| A | Isolated New Architecture Android/iOS app | Native CI PASS on #430 and #431 exact heads; preview only |
| A | Shared contracts used by desktop and native | Implemented; core/desktop contract CI PASS on #430 and #431 |
| A | Types, lint, coverage, dependency audits | Exact-head CI PASS on #430 and #431; stricter release/physical gates remain separate |
| A | Reproducible **debug** Android and iOS builds | Native emulator/simulator CI PASS; iOS committed Podfile.lock in `--deployment` mode PASS on #431; signed release builds unverified |
| B | Login, registration, sessions, multi-account, switching | OPEN; preserve existing auth/CSRF/step-up protocols |
| B | Communities, DMs, channels, threads, messages, profiles | OPEN; native navigation and authorized API client required |
| B | Realtime ordering, deduplication, reconnection | OPEN; reuse existing Socket.IO contracts |
| B | Durable offline state, outbox and process-death recovery | OPEN; account-scoped storage and queue reconciliation required |
| B | Keystore/Keychain and encrypted local state | OPEN; no key storage implemented by this foundation |
| B | APNs/FCM, notifications and native channel deep links | OPEN; authorization and running-app delivery required |
| C | Search, saved messages, inbox, settings and unread state | OPEN; preserve existing visibility/expiry rules |
| C | Voice, video, screen share, audio routes, interruptions | OPEN; native WebRTC/mediasoup and OS lifecycle acceptance required |
| C | Attachments, chunked/resumable transfers and integrity | OPEN; preserve existing transfer and authorization contracts |
| C | Existing E2EE boundary, deletion and step-up parity | OPEN; no production-grade E2EE claim; see P7 security boundary |
| C | Accessibility, localization and all Capacitor features | OPEN; basic native labels/themes only; full parity remains required |
| D | Network interruption, background, cold/warm/process-death | OPEN; foundational resident-resume journey is insufficient |
| D | Representative performance, memory, battery and media | OPEN; measured hardware/scenarios required |
| D | Physical Android and iOS acceptance | OPEN; simulators cannot substitute |
| E | Data-preserving upgrade and rollback | OPEN; no old data touched or migrated |
| E | Reviewed, owner-approved cutover | OPEN; no integration or retirement authorized |

Relevant existing feature owners include `client/src`, `client/tests`, native
Capacitor overlays under `mobile/`, and `docs/P4_MOBILE_NATIVE.md`. Before moving
each feature, inventory its implementation and tests and extend this ledger with
executable native parity evidence. A source scaffold or green build cannot close
an unimplemented row.

## P7 and historical failures remain independent

Issue #321 and P7 candidate #375 remain open/unmerged. Android #209's historical
ANR cause and physical-device evidence remain unresolved. Linux Wayland #416's
real xdg-toplevel failure is unrelated to mobile migration. Preserve the old iOS
WKWebView discovery failure (run 40138800251) and WebDriver ECONNRESET (run
40139119267). The newer #425 native Open-confirmation journey and D2L01 passed
on `ef0ff674` in run 40141301927, but that does not explain the prior startup
failures or verify the older simctl-only I07 route. P8 is not an automatic fix
for any of these failures.

The next functional milestone is an authenticated native session using the
existing server contract, reviewed secure storage, explicit redirect/cookie
isolation, and adversarial account-switch/deletion tests. Existing E2EE guarantees
must be preserved without inventing cryptography; the limitations in
`docs/P7_E2EE_SECURITY_BOUNDARY.md` remain applicable.
