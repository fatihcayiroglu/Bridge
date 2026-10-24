# I07: observe and accept the actual iOS opening confirmation

The existing simctl-only smoke remains separate: routing a URL in LaunchServices
and observing `systemModalAlert` do not prove delivery. Its historical I07
UNVERIFIED results are preserved. No physical-iPhone acceptance is claimed.

This adds a native XCUITest journey after the existing D2 journey has completed
and written its own report. A separate Appium session uses the pinned driver's
supported `noReset: true`, `autoAcceptAlerts: false` and `forceAppLaunch: true`
capabilities. That launch is journey setup, not a HOT resume. D2's existing
background/resume PID assertion is unchanged; the I07 PID is measured separately
immediately before the OS request and must match after confirmation AND after
WebView discovery/navigation.

The test restores the actual existing account, lists an authorized new target,
and starts on another permanent channel. It sends the custom-scheme URL through
`xcrun simctl openurl`, requires a newly observed native system alert naming
Bridge with exactly Open/Cancel buttons, and uses XCUITest's documented
`mobile: alert` with the explicit Open button. It then requires the real target
channel active in the packaged WKWebView of the same native process. A preexisting
alert, unknown prompt, missing confirmation, cold restart, wrong application or
wrong target fails. There is no synthetic deep-link/lifecycle event, direct JS
navigation, relogin, reload, fallback pass or journey retry.

The Open/Cancel labels deliberately scope this first acceptance to the English
CI simulator. Other system languages require their own reviewed expectation,
not a generic accept-all action. The pinned driver's documented
`respectSystemAlerts` setting exposes SpringBoard alerts to native lookup. The
original D2 session retains its existing settings and all its assertions.

`open-confirmation-journey.json` records an independent `I07-XCUITest` result with
booleans, stage and duration, without URLs, channel/account identifiers, alert
text or native UI source. An I07 failure fails the job but preserves an already
completed D2 PASS as D2 evidence. The new result must be PASS at the shell gate;
UNVERIFIED is never converted into a pass.

Local verification: **20 Node transport/evidence/control tests PASS, zero
skipped**, including adversarial cold-restart, wrong-target, preexisting-alert
and wrong-confirmation controls. JavaScript and Bash syntax checks PASS. These
unit fixtures are not native acceptance. **Real iOS simulator execution is still
required; this document does not yet claim I07 PASS.**

Driver contract reviewed at the exact installed commit:
`appium/appium-xcuitest-driver@77dfb1390ed33914555bfeb37ace8c9ab2f57b28`,
`docs/reference/capabilities.md`, `settings.md`, and `execute-methods.md`.
No production iOS layer, signing entitlement, dependency pin or privacy setting
changes. Review and exact-head native CI remain required; #321/P7 stay open.
