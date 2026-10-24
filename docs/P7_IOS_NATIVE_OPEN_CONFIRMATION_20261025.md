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

Local verification: **27 Node transport/evidence/control tests PASS, zero
skipped**, including adversarial cold-restart, wrong-target, preexisting-alert
and wrong-confirmation controls. JavaScript and Bash syntax checks PASS. These
unit fixtures are not native acceptance. **Real iOS simulator execution is still
required; this document does not yet claim I07 PASS.**

Driver contract reviewed at the exact installed commit:
`appium/appium-xcuitest-driver@77dfb1390ed33914555bfeb37ace8c9ab2f57b28`,
`docs/reference/capabilities.md`, `settings.md`, and `execute-methods.md`.
No production iOS layer, signing entitlement, dependency pin or privacy setting
changes. Review and exact-head native CI remain required; #321/P7 stay open.


## First-attempt failures and bounded startup evidence

The first native run on `07ba279f`, workflow **40139119267**, failed before I07
executed: native-session creation lost its connection with ECONNRESET after
603,025 ms. No I07 report or PASS was produced. The earlier #423 PR check on
synthetic merge `a5035d99` (tree identical to head `d0b4e12f`) failed differently:
the correct native process/packaged WebView was selected, but Bridge DOM was
absent. Its original D2 FAIL and the later, independent smoke UNVERIFIED remain.
Neither observation establishes a product root cause.

The next revision records a bounded startup summary before deleting the private
Appium log: only known WDA/Xcode/proxy/inspector stage flags and counters, an
Appium process-health snapshot and explicit truncation state. It never retains
capabilities, WebDriver arguments, response bodies, identifiers, URLs or compiler
errors. A failure-only read of an already selected packaged page records document
readiness, frame/index/body/script shape and bounded early-error counts without
HTML, error text, titles, input values or navigation. Missing error state stays
unknown, rather than being reported as zero errors.

These additions improve diagnosis; they do not extend a deadline, retry a journey,
waive missing native evidence or fix the unexplained startup failures. All 27
local control/transport/evidence tests pass with zero skips. Actual native I07
acceptance remains required on the updated code.
