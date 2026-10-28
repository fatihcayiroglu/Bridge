# Native account switching: approved owner decision

Owner decision, 2026-10-28: **approved isolated native flow**. This document remains
the design record; the implementation is reviewed separately and does not alter
the existing case3 assertions. P7 remains OPEN.

## Verified blocker

#548 exact head `d8ec3264a073ac8a2d4c70b8c5ebc586fbfab9c0`, first-attempt run
[40714331771](https://github.com/fatihcayiroglu/Bridge/actions/runs/40714331771),
job122907768960: cancellation PASS, A authentication/restart/rotation PASS,
switch/isolate/revoke/restart FAIL at `MOBILE_AUTH_DEADLINE:custom-tabs-login`.
Two passed / one failed / zero NOT EXECUTED cases / zero skipped tests.
The B authentication, isolation, revocation and final restart substeps were not
reached. The earlier head `8bc0495b` has the same two-pass/one-fail result.

The current artifact was independently downloaded and its GitHub SHA256 checked:
`be2ec9b338c1d679b3c6ce00f74cf39f00856eb4ad1e4c1df7dea031f1f1d102`.
Its browser evidence confirms the consent offers the previous account. No
username, password, code or token is reproduced here. This is a product-flow
failure, not an unavailable image or a retryable test flake.

## Existing boundary and why a query flag is insufficient

- The RN Switch account action revokes its native session, then invokes the same
  browser sign-in entry point as an ordinary sign-in.
- Android Custom Tabs shares the Chrome profile's web session. iOS requests an
  ephemeral ASWebAuthenticationSession; this does not replace equivalent account
  selection requirements or constitute tested iOS parity.
- `client/js/core/native-auth-consent.ts` captures a pending state/challenge and
  offers consent after ordinary web authentication or restoration.
- `server/routes/nativeAuth.ts` accepts the httpOnly `bridge_refresh` cookie for
  consent. It rotates that browser credential and issues a one-use PKCE code.
- Ordinary password, 2FA, WebAuthn and SSO completion paths in the existing server
  set the shared browser refresh/media cookies. Showing their login form with
  `prompt=login` alone would neither enforce fresh authentication on the server
  nor preserve the existing browser session when B signs in.
- Accepting a script-readable access/step-up token as an alternative to the
  consent cookie would alter the documented native credential security boundary.
  That is not an acceptable shortcut.

## Recommended option: isolated browser transaction for native switching

Keep ordinary browser sessions intact. Add a **short-lived, server-owned native
authorization transaction** only for intentional account switching. Continue to
use the system browser and existing native code/token/refresh contracts.

1. A switch request creates an opaque transaction bound to exact redirect URI,
   state and S256 challenge, with a bounded expiry and one-time completion.
   The verifier remains only in the native process. The transaction lives in the
   authoritative store; Redis failure must fail closed in a Redis deployment.
2. The system browser opens a dedicated native-switch page. A separate
   HttpOnly/Secure/SameSite cookie, with a narrowly scoped native-browser path,
   binds that browser to the transaction. The ordinary `bridge_refresh` cookie
   cannot satisfy this transaction and is never cleared, rotated or replaced.
3. The page requires fresh account authentication. Reuse the existing identity
   verification services and policy checks: rate limits, CAPTCHA, email policy,
   2FA, WebAuthn/SSO where configured, tokenVersion and revocation checks.
   No native credential is minted while a factor is pending. Unsupported routes
   fail closed; no password-only fallback for a stronger configured policy.
4. Successful verification records the transaction's selected user and fresh
   authentication state on the server. This completion path does not issue a
   normal browser access/refresh/media session. It must be factored with the
   existing policy pipeline, not an independently weakened login implementation.
5. Explicit consent names the selected account. A same-origin, CSRF-protected
   top-level POST consumes the authenticated transaction and uses the existing
   one-time code issuer. It redirects to the exact registered native URI; the
   code is never returned to page JavaScript or a script-readable JSON body.
6. The app retains state/PKCE validation and #542 ownership/epoch fences. It
   persists only the new native refresh credential through the existing native
   coordinator, then reads B's authenticated backend data. Cancellation never
   restores A's native session implicitly. Replay/expiry/revocation remain strict.

This requires a material server/web authentication-context change. Endpoint and
cookie details, browser lifetime, factor continuations and threat-model tests
must be reviewed before implementation. The user explicitly required owner
approval for this scope; this draft is the concrete proposal for that approval.

## Smaller alternative: explicitly change this browser profile's web account

Reuse the existing web sign-out and full login pipeline, with a clear confirmation
that switching also changes Bridge's account in this browser profile/tabs. Revoke
only that current browser refresh family, never logout-all or other profiles and
devices. Preserve the pending native request safely through the transition and
retain normal consent after B authenticates.

This avoids a new native-browser authentication transaction but affects other
Bridge tabs in the same profile. Do not choose this product behavior implicitly.
Neither option clears Chrome data, installs a fake session or changes case3.

## Required verification after the decision

- Regression: existing web browser A remains authenticated after native B switch
  for the recommended option, including another live tab and refresh. Unrelated
  profiles/devices remain authenticated in either option.
- Negative server controls: existing cookie A cannot satisfy a fresh-switch
  transaction; missing/expired/replayed transaction, wrong browser/CSRF/origin,
  wrong state/challenge/redirect, pending2FA and revoked tokenVersion cannot
  issue a code. No native credential in JavaScript-readable responses.
- Existing code/refresh replay and account/session race protections remain green;
  negative or mutation controls must fail against the vulnerable behavior.
- Real PostgreSQL16/Redis integration: authoritative transaction, atomic consume,
  rotation/revocation and A/B separation; no fallback to fake stores.
- Unchanged Android cases1–3 must all pass through actual Custom Tabs, OS callback,
  process termination, protected restoration and sign-out rejection. Do not
  change the case3 login requirement to accept accountA again.
- Run the equivalent iOS journey after #553's independent field-focus and WDA
  prerequisites are verified. Keep unexecuted cases explicit.
- Physical devices, verified links, reinstall/backup policy, all-OS feature
  parity and release performance remain separate open acceptance gates.
