# P7 iOS password-entry focus gate — native verification required

## Preserved evidence

Parent #619 exact `e7349e266807156879de02e68f49c32fcde66689` has passing
228-test pilot, PG16/Redis/backend/browser and Android/iOS storage-runtime jobs.
Its **first** system-browser run
[41011553492](https://github.com/fatihcayiroglu/Bridge/actions/runs/41011553492),
job `123918346742`, nevertheless **FAILED**: 1 PASS / 1 FAIL / 1 NOT EXECUTED.
On iOS 18.5 the cancellation case passed. Authentication failed at
`LOGIN_PASSWORD_TYPED_INTO_USERNAME_FIELD`; rotation/account-switch requirements
are not qualified by this run. It contained zero authentication screenshots.

Artifact `12958596769` SHA-256 verified:
`fb19d9efd8119b80c9c5087a2e476a04ddc156a429dfda5b052a26d1b8af4d24`.
Each case had two completed document responses with HTTP 200 and established TLS
connections. Thus this observation reached the page; it is not the prior
no-fields deadline. Other 401/400/503 resource requests were observed but not
attributed to a root cause. The username contained appended password characters
and the secure field remained empty. The XML focus flags were null. The field
rectangle moved after username entry; taps did not establish keyboard focus.

## Change and source basis

Before sending any password, query the native active element and its native type.
If the username text field remains active, send one ordinary keyboard Tab, then
require the secure field to be active. Unknown focus, transport errors, unchanged
text focus, changed username or non-unique visible secure fields fail closed.
There is no repeated focus attempt, injected JavaScript, DOM manipulation,
credential/cookie/callback injection, reload or deadline increase. The original
post-typing username and secure-field-length assertions remain mandatory.

The exact driver pinned in the repository,
[`77dfb139` native active/name implementation](https://github.com/appium/appium-xcuitest-driver/blob/77dfb1390ed33914555bfeb37ace8c9ab2f57b28/lib/commands/element.ts),
forwards `/element/active` to WDA in the native context. The lockfile pins WDA
16.17.2; npm's gitHead resolves to `e44d107586127a4b666f81688dbcd4bcf61b6cd3`.
Its [active-element selector](https://github.com/appium/appium-ios/blob/e44d107586127a4b666f81688dbcd4bcf61b6cd3/packages/webdriveragent/WebDriverAgentLib/Categories/XCUIApplication%2BFBHelpers.m)
uses `hasKeyboardFocus == YES`, and its
[name handler](https://github.com/appium/appium-ios/blob/e44d107586127a4b666f81688dbcd4bcf61b6cd3/packages/webdriveragent/WebDriverAgentLib/Commands/FBElementCommands.m)
returns the element's `wdType`. This avoids treating a missing XML `focused`
attribute as positive evidence. Neither API returns the field value here.

Only fixed text-field/secure-field/other types and the navigation method are
recorded. Six focused behavioral tests cover already-secure focus, one-step
navigation, refused unchanged/unknown focus, propagated transport failure and
username/secure-field uniqueness. Related tests passed **42/42**, zero skipped;
pilot TypeScript passed. A source-order regression now explicitly requires the
awaited gate between the snapshot and password send. No assertion was dropped.

## Acceptance remains OPEN

Native Tab behavior in ASWebAuthenticationSession must be tested in the actual
simulator. Unit doubles cannot establish that it advances WebKit focus. The gate
may correctly fail before typing a password; that is not successful native auth.
Require fresh exact-head CI and preserve its first result, no rerun for green.
The parent's storage self-tests and real HTTP PKCE tests do not substitute for
the system-browser callback, SecureStore rotation/restoration and isolated
account-switch journey. Physical devices, OS coverage, messaging/calls/uploads/
notifications and measured startup targets remain separately unqualified.
Preserve #553/#619 histories, keep draft/P7 open, no production merge/deploy.
