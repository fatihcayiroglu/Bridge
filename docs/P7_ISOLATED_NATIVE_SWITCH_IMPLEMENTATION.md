# Isolated native account switch — review candidate, P7 OPEN

Owner approved the isolated native-flow option on 2026-10-28 after reviewing
#559's proposal. This implementation is stacked on #548 and that design review;
it does not rewrite either PR or change case3's acceptance assertions.

## Behavior and security boundary

The real RN Switch account button revokes the native session and requests the
dedicated `/native-auth/switch` entry. Ordinary sign-in keeps the existing path.
Fresh intent is captured before asynchronous PKCE generation and forwarded
through the existing generation/epoch fence. State, S256 and callback checks
remain identical; a query hint alone is not treated as fresh authentication.

The server renders a separate, script-free login/consent document (except an
operator-configured CAPTCHA widget). It never starts the SPA, reads browser
access-token storage or restores the ordinary browser account. Each transaction
has an independent, narrow-path HttpOnly/Secure/SameSite=Strict cookie and CSRF
proof, a five-minute absolute lifetime, and an exact server-bound redirect,
state and challenge. Neither the existing web refresh cookie nor bearer access
tokens can satisfy this fresh flow.

Password and TOTP/backup-code completion reuse the actual normal authentication
handlers through server-selected destination callbacks. CAPTCHA/rate-limit,
email-verification, password timing, factor challenge, durable TOTP/backup replay
checks and tokenVersion policy are retained. Before any normal access/refresh/
media credential is minted, the native destination records only a short-lived
server-side identity proof. The MFA challenge stays server-side and a submitted
replacement challenge is ignored. No normal web cookie or web token is created,
changed, rotated, cleared or exposed by this completion path.

Consent is explicit and names the newly verified account. Cookie/CSRF/origin
checks precede mutation; phases are compared and consumed atomically (Redis Lua
in configured deployments, serialized explicit single-node fallback otherwise).
A late login cannot erase a newer phase. One consent wins; expiry, cancellation,
revocation and authoritative-store uncertainty fail closed. The existing native
one-time code issuer and token endpoints perform the same PKCE exchange, replay
revocation and refresh rotation. Code redirects have empty bodies/no-referrer;
no authorization code or long-lived credential is returned to page JavaScript.

## Validation at authoring time

- Existing native-auth/cookie contracts31/31 passed after the handler refactor.
- Final combined nine suites of password, factor-race, native-auth, application
  wiring and cookie contracts120/120
  passed, zero failed/pending/skipped/TODO. These use the actual handlers with
  an in-memory repository: NOT PostgreSQL or native acceptance.
- Relevant native browser/session contracts25/25 passed; TypeScript passed.
- Ten negative/mutation controls were all caught by actual failed assertions:
  normal-web completion fallthrough (password and MFA), premature MFA completion,
  lost cookie/origin bindings, missing one-time consumption, missing phase or
  revocation checks, normal entry used for fresh intent, and dropped forwarding.
  Every final mutant ran all17 server or all4 client cases, zero skipped/TODO; no
  compile failure was counted as a killed mutant. Sources were restored after
  every controlled mutation. The first campaign's local UTF-8 report-decoding
  error and its test JSON were retained separately.
- Server and pilot TypeScript and the actual web build passed. Scoped production
  ESLint passed; test files follow the existing repository ignore policy. Exact
  dependency audits contain root7LOW, server6LOW, Electron6LOW, pilot0 and E2E0,
  with zero moderate/high/critical findings in these installed lockfiles.
- A new mandatory real PostgreSQL16/Redis case tests production client modules,
  isolated B authentication, two preserved A browser profiles, wrong-cookie and
  cross-origin refusal, late-login rejection, concurrent one-time consent,
  reconstructed-coordinator restoration/rotation and sign-out rejection (not
  an OS-process or protected-storage test). The required count rises18→19;
  none of the existing18 cases is removed. This case is NOT EXECUTED locally
  because this Windows environment has no running disposable backend services.
- Real Android case3 remains unchanged and must pass on this exact candidate.
  The historical2PASS/1FAIL on #548 is preserved, not counted as a pass here.

## Explicitly open

This first implementation adds password + required TOTP/backup authentication.
Passwordless WebAuthn/SSO **switch** completion still needs a dedicated continuation
in the isolated context and real qualification. The candidate page does not
pretend those methods are implemented, and no account or factor policy is
relaxed to supply a password fallback. Existing normal web WebAuthn/SSO routes
are unchanged. CAPTCHA verification uses the existing server policy; actual
operator-provided widget acceptance is still required where configured.

Native iOS field-focus work remains independently based on #553; its latest
`c4b7c3d1` run40717519808 passed WDA prebuild in177s but again failed case2 with
`LOGIN_PASSWORD_TYPED_INTO_USERNAME_FIELD` (1PASS/1FAIL/1NOT EXECUTED). Its artifact
is preserved; touch/fresh geometry is not called fixed. This Android candidate
does not yet include #553's whole independent harness stack or claim iOS parity.
The subsequent #553 head `758883475010c6c1be3c609e57c5d5f49c932e56`
adds another focus diagnostic/tap; run40725593481 remains in progress at this
checkpoint. Its backend40725593973, JS40725593500 and native-storage40725593675
checks passed independently; none proves that the browser focus defect is fixed.

Physical devices, verified links/owner release identities, iCloud/reinstall
policy, full messaging/uploads/calls/notifications parity, all-OS compatibility,
release performance and lossless migration stay open. Capacitor/user data, web,
Electron and B1 are preserved. No production merge or deployment.
