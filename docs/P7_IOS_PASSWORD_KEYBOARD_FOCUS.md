# iOS password keyboard-focus gate — P7 OPEN

This candidate is stacked on #553 ata9da3508c37b9d223caa1bb1d2e25362994ffb47,
preserving its subsequent keyboard-typing experiment behind the ownership gate.
Run40725593481/job122947851851 passed WDA prebuild and reached the actual iOS
authentication browser, then failed `LOGIN_PASSWORD_TYPED_INTO_USERNAME_FIELD`:
1PASS/1FAIL/1NOT EXECUTED, zero skipped acceptance cases. The original artifact
is preserved with SHA256
`2232e801f1b81c2e010ec6488ca7576395788734548d0c809fc86585b05a557e`.

The new native tap did not establish success. Its recorded page-source focus
snapshot is text:[null],secure:[null]. Neither field supplied a focus attribute,
so the diagnostic cannot prove which input receives keyboard events. The first
failure geometry is retained without printing usernames, passwords or raw AX.

The exact pinned appium-webdriveragent16.17.2 source was inspected from its
[published package](https://registry.npmjs.org/appium-webdriveragent/-/appium-webdriveragent-16.17.2.tgz).
`FBFindElementCommands.handleGetActiveElement` uses
`XCUIApplication.fb_activeElement`, which queries `hasKeyboardFocus == YES` on
iOS. This is distinct from the optional page-source `focused` attribute and the
tvOS focus implementation. The harness now requires `/element/active` to return
the exact freshly located password element, whose native type must be
`XCUIElementTypeSecureTextField`, before issuing any password value command.

The existing bounded wait polls keyboard ownership. No-such-element is pending;
transport/session errors propagate. A missing, different, ambiguous or nonsecure
target never receives the password. Only three booleans are retained/printed:
activeFound,targetMatches,secureType. The existing native touch sequence, username
integrity assertion, system browser, PKCE, consent, callbacks, native storage,
three mandatory cases and240s WDA-session deadline are preserved. No test rerun,
new coordinate guess, WebView script or authentication bypass is introduced.

Local relevant contracts17/17 PASS, zero failed/cancelled/skipped/TODO. These
include delayed username-to-password focus, another secure element, no active
element, missing/wrong type, transport failure and closed evidence. They verify
the guard, not XCUITest behavior. Actual native focus acquisition and case2/3
remain UNVERIFIED until the new exact-head native run. If the gate times out,
that is an honest failure requiring further root-cause evidence, not a pass or
a claim that the original focus defect is fixed.

This branch does not include #560's separate native account-switch server
implementation. Full combined Android/iOS acceptance, physical devices, OS
coverage, performance, feature parity and lossless migration remain open.
No production merge, deployment, user-data removal or B1 change.
