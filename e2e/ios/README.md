# iOS simulator acceptance

`run-simulator-smoke.sh` proves native build/launch and the specifically reported
OS deep-link observations. It does not exercise channel expiry.

`run-expiry-journey.sh` drives the real Debug Capacitor app through Appium's
XCUITest driver and its WKWebView context. It requires macOS, Xcode, a built
simulator `.app`, and a running Bridge backend with real PostgreSQL and all
migrations applied. `.github/workflows/mobile-ios.yml` provisions these services.
Both checks gate that workflow; failures are not retried as whole journeys.

The D2L01-iOS journey requires all of the following:

- Real UI login and navigation, and live channel creation from another API session.
- An encrypted draft and history record observed in IndexedDB before expiry.
- Native backgrounding confirmed by XCUITest before the database clock expires
  an owner/API-configured channel. The short interval is a test fixture update;
  the product's minimum lifetime is unchanged.
- Immediate server denial of expired history, independent of cleanup timing.
- Native activation with the same process identity, without reload or relogin.
- Removal of the channel, active selection, encrypted history, encrypted draft
  and legacy localStorage entries after resume.
- A permanent channel remains authorized and its encrypted draft is restored.

Missing services, WebView access, process identity or durable encrypted storage
fail the test. There is no desktop substitute or memory-storage fallback counted
as evidence. Results contain bounded booleans/timings, not tokens or conversation
records. Simulator evidence is not physical-device, APNs or radio evidence.

## Dependency provenance

Appium is pinned to `3.8.0`. The XCUITest driver is upstream release `12.20.0`,
source commit `77dfb1390ed33914555bfeb37ace8c9ab2f57b28` (verified against its
upstream Git tag). The npm release bundles `shell-quote@1.10.0`, affected by
GHSA-pqg4-j6r4-53mv; npm overrides cannot replace that bundled copy. Older npm
releases also ship shrinkwrapped vulnerable dependency graphs.

The commit-pinned source does not include that bundle or shrinkwrap. npm builds
the upstream TypeScript driver and resolves its declared dependencies through
our lockfile, with the compatible `shell-quote@1.11.0` override. No driver source
or cryptography is modified. The resulting graph audits with zero findings.
The Quality Gate and iOS workflow audit this separate tooling workspace at
`--audit-level=low`; root, server, Electron and browser E2E audits remain intact.

The generated CI Debug plist permits only the `localhost` HTTP fixture. No
release plist, arbitrary-load exception, or remote-host exception is changed.
WKWebView inspection uses Capacitor's existing Debug-only setting.

Local syntax checks on Linux cannot establish iOS acceptance. Only a successful
native workflow run with `expiry-journey.json` reporting `D2L01-iOS: PASS` on the
tested commit establishes this simulator journey.

First native run (`baf8f75f`, run 39931429924) failed before obtaining a WebDriver
session: Appium's default 120-second simulator boot wait expired. The subsequent
preserved smoke launched Bridge and observed its native bridge ready after 22
seconds. Automation startup now uses the same 480-second simulator boot bound
as the existing smoke, and supplies the simulator's actual runtime version.
Product assertion deadlines and acceptance requirements are unchanged. This is
not counted as a passed expiry journey; a new commit must execute the full test.
Inspection of the installed driver's `appium-ios-simulator` startup confirmed
that its GUI default shuts down an already booted headless simulator and restarts
it with a window. The workflow's early boot is headless. `isHeadless: true` now
preserves that warmed simulator rather than discarding the startup preparation.

The next native run (`62fae462`, run 39933990825) passed simulator preparation
but its Node `fetch` request failed during session creation after 342 seconds,
before any product assertion. An independent fetch header deadline can preempt
the explicit 840-second session deadline. The WebDriver client now uses Node's
HTTP transport with one abort deadline and bounded/redacted response handling.
Executable transport tests cover delayed headers, aborting stalled requests,
invalid/oversized responses, W3C failures and credential redaction. The native
journey still must pass; neither startup run is expiry acceptance evidence.

Run 39987898065 (`8484f73c`) successfully created its native session, then failed
the packaged WebView context assertion. The harness now preserves only counts
and booleans describing context discovery and the expected packaged document;
no URL, page title, account content or credentials are recorded. It also asserts
the compiled app's existing `CAPACITOR_DEBUG=true` before automation starts.
The required context and product assertions are unchanged; this diagnostic
change is not an accepted expiry journey or a retry of an unchanged test.

Run 39993002937 (`ee9825e5`) established the discovery cause: Bridge was active
in the foreground, with three native WebView nodes and two login text fields,
while Web Inspector advertised its process as `process-App`, not its signed
bundle identifier. The pinned upstream debugger matches exact bundle aliases;
its default filter never selected that process. The harness now supplies this
one observed alias through `additionalWebviewBundleIds`. No wildcard is used.
The selected WebView must also match the foreground `com.bridge.app` process
PID, the packaged origin, the Bridge DOM and Capacitor's native iOS identity.
These stricter checks and the unchanged complete lifecycle assertions must pass
in a new run; discovery diagnosis alone is not D2 acceptance.

Run 39995680530 (`0b3ea23a`) passed those identity/origin checks, logged in through
the native app and selected the permanent fixture channel. It then failed to
observe an encrypted draft record. This remains a real acceptance failure.
The next diagnostic preserves only record counts and browser capability/DOM
booleans to distinguish absent encryption/storage from a composer-context issue;
the mandatory persisted-draft assertion remains unchanged.

Run 40001865845 (`6d684625`) isolated the storage failure on the real simulator:
all three non-extractable CryptoKey writes raised `DataCloneError`, including
the immediate write and the IndexedDB callback form. No record was stored.
Linux WebKit 1.61.1 passed the same primitive probe, so changing transaction
timing would not address the observed native failure.

## Native local encryption boundary

The private `@bridge/local-first-crypto` Capacitor plugin uses Apple's CryptoKit
AES-256-GCM and generic-password Keychain entries. Keys are random, account
scoped, non-synchronizing and `WhenUnlockedThisDeviceOnly`; key bytes never cross
the JavaScript bridge. CryptoKit supplies a fresh 96-bit nonce for every write.
The existing version-1 envelope, 128-bit authentication tag and authenticated
user/namespace/record scope are preserved. Input sizes and canonical base64 are
checked; errors contain no plaintext, key bytes or account identifiers.

The composition root preserves a working browser key. It selects Keychain only
after the observed `DataCloneError`, and keeps that choice across OS upgrades
by checking the existing native account key first. It reports durability only
after both IndexedDB and key persistence succeed. Provider failures fall back
honestly to non-durable memory. Native decryption and encryption cannot recreate
a deleted key; initialization is explicit. Account wipe deletes records before
the key, and preserves the key if record deletion fails.

The iOS workflow compiles and runs `key-vault.test.swift` against **real macOS
Keychain and CryptoKit** before building the app. These mandatory tests cover
persistence, tampering, account/scope isolation, erasure, bounds and two-way
interoperability with the production WebCrypto envelope. JavaScript unit tests
separately cover adapter composition and failure paths with a mocked native API.
The native lifecycle journey remains mandatory and is the iOS-specific evidence
for the packaged plugin. No new cryptographic primitive or E2EE claim is made.

This is still a draft requiring native validation and security review.

Account deletion now erases this device's local-first data of the deleted
account (`client/js/core/local-first/account-erasure.ts`, called by the
Privacy tab after the server confirms deletion and before logout):
- encrypted records of every namespace, the legacy plaintext drafts, the browser
  IndexedDB key and the native Keychain key;
- records are deleted before keys, so a failed record wipe never orphans
  undecryptable ciphertext.

The account is marked erased first, and the mark is persisted. From then on:
- no store for it opens durable storage;
- no key is created for it;
- no encrypted record is written for it, including by a write already in
  flight.

The startup sweep completes an interrupted wipe and removes anything a late
write landed. `local-first-account-erasure.test.ts` covers each guard with its
own negative control. Ordinary logout still retains local drafts by existing
policy. Device-only Keychain entries do not synchronize
or migrate in a backup, and reinstall/key-loss behavior needs separate product
acceptance; it is not established by this simulator expiry journey.

Run 40010032013 (`55bf20dd`) passed all 14 real macOS Keychain/CryptoKit checks,
the two-way envelope interoperability check, plugin discovery and Xcode build.
It still failed the mandatory permanent-draft assertion. Native smoke logs show
the plugin receiving `hasKey` calls and rejecting them, so the remaining failure
is in the native Keychain path, not missing plugin registration. The next run
preserves only read-only key-availability booleans and a numeric Security.framework
status after failure. It never initializes a key or seeds records from the test.
No signing/protection setting or persistence assertion is relaxed.

### Simulator signing (Keychain error -34018)

The `a6ce1de7` run recorded that numeric status: every native key operation
returned `-34018` (`errSecMissingEntitlement`). The workflow built the app with
`CODE_SIGNING_ALLOWED=NO`. An unsigned app carries no entitlements, so iOS
cannot assign it a Keychain access group and refuses every Keychain call. The
macOS vault tests pass because a command-line binary on macOS uses the login
keychain without that requirement.

The simulator build is now signed ad hoc (`CODE_SIGN_IDENTITY=-`, the
"Sign to Run Locally" mode; no team, certificate or profile). It uses
`mobile/ios-simulator-debug.entitlements`, which grants exactly the app's own
group (`$(AppIdentifierPrefix)com.bridge.app`). The vault's queries name no
access group, so they use that one. Nothing in the vault, its accessibility
class (`WhenUnlockedThisDeviceOnly`, non-synchronizable), the plugin or any
journey assertion changes. Release and device builds are signed with the
team's provisioning profile and do not use this file.

The entitlements attach to the App target's Debug configuration only, through
`scope-simulator-entitlements.mjs`. Passing `CODE_SIGN_ENTITLEMENTS` on the
xcodebuild command line applies it to every Swift package target as well.
Run 40021067365 failed exactly that way, and that route would also have
granted package bundles the app's Keychain group. The script edits exactly one
configuration and refuses to override an existing value. It was checked
against Capacitor's SPM and CocoaPods templates and the curated project.

`verify-simulator-signature.sh` gates the journey on what the built binary
actually carries rather than on build settings:
- `codesign --verify --deep --strict` must pass, with `Signature=adhoc`;
- the entitlements are read from the signature and from the `__TEXT,__entitlements`
  section that the simulator honours;
- at least one source must grant the app's own Keychain group;
- any other or wildcard group fails the job.

The summary is kept as `signature-summary.json` with the other evidence.
