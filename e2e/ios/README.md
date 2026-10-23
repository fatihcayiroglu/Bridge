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
