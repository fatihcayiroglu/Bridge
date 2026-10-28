# iOS system-browser authentication acceptance (P7 OPEN)

This draft increment starts at #543, `494ebbd3e1b10464d08c1395923572bc364ba25a`.
Its historical Chromium and native storage results remain separate from the
new iOS browser journey. A workflow or test implementation is not a PASS.

`native-pilot-ios-browser-auth.yml` builds the normal React Native screen
(`EXPO_PUBLIC_NATIVE_SELF_TEST=0`) and drives it with native XCUITest through
Appium. The shipped `expo-web-browser` implementation uses
`ASWebAuthenticationSession`. The driver never injects browser responses,
cookies, tokens, callback URLs, or page JavaScript. It never uses `simctl openurl`.

The disposable runner owns a freshly initialized PostgreSQL 16 directory,
Redis directory, database, users and private communities. HTTPS uses a generated
one-run CA explicitly installed in the simulator trust store. Certificate
validation, ATS, authentication and callback checks are not disabled.
Neither production data nor an existing database directory is used.

Three mandatory cases run once, without journey retries:

1. Cancel the actual system browser; the same native process resumes and no
   native code exchange occurs.
2. Sign in as A, explicitly consent, return through the OS callback, exchange
   exactly one code without browser cookies, and display A's private community
   fetched from the authenticated backend. Terminate the app and verify a new
   native process restores through real SecureStore/Keychain and rotates one
   refresh credential. PostgreSQL must show the used predecessor and one new
   active successor in the same family.
3. Switch to B through the real browser, reject A's community/session, repeat
   protected restoration, sign out, independently require the revoked credential
   to return HTTP 401, and restart without restoring credentials.

Native-return checks require the intended bundle, process identity, native
Sign out / Switch account controls, and no web view. A private community visible
in the authentication browser cannot satisfy native authentication acceptance.

The evidence artifact retains exact head, build logs, closed wire facts,
screenshots and the case verdict. Initial failures are retained per run/attempt.
Raw WebDriver command traffic, source XML, credentials and callback URLs are
not uploaded. A prerequisite failure leaves every unfinished case explicitly
NOT EXECUTED. Zero skipped cases are permitted.

Tooling is reused byte-for-byte from #481's existing implementation at
`0b0b020c7627cc427571fe21c433834aa95ab25b`: `e2e/ios/package.json`, its lockfile,
`webdriver-http.mjs`, and its six HTTP transport contract tests. This does not
merge or change #481. Native acceptance still requires this increment's own
exact-head execution.

## Remaining acceptance and owner-controlled prerequisites

- This is a debug simulator journey, not physical-device, release-signing,
  reinstall-policy, production performance, Android Custom Tabs or exclusive
  verified-link evidence.
- #537 remains disabled by default. The private scheme registered for this test
  proves functional OS dispatch, not protection against another app registering
  that scheme. No callback validation is relaxed.
- Production verified links require the owner's HTTPS authentication domain and
  association-file hosting, Android release signing SHA-256 fingerprint, and
  Apple Team ID / application identifier with real provisioning. None is
  fabricated. Physical-device link interception and association verification
  remain NOT VERIFIED until these are supplied and exercised.
- Meaningful UI under 1 second and usability under 2 seconds require measured
  release-runtime evidence. Metro prewarming is only a test prerequisite.
- #209, #416 and P7 remain OPEN. No deployment or production merge is authorized.
