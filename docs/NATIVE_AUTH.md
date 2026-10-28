# Native sign-in (Android / iOS): authorization code + PKCE

Status: server contract implemented and unit/route-tested. The web consent page
and the React Native client are separate changes. **Nothing here is native-device
evidence**; physical Android and iOS acceptance is still required before rollout.

## 1. What existed (verified on main `c061d72f`)

| Contract | Verified behaviour | Consequence for a native client |
|---|---|---|
| `POST /api/login`, `POST /api/2fa/check`, WebAuthn, SSO | Access token in JSON; refresh token **only** as `bridge_refresh` cookie (`HttpOnly`, `SameSite=Strict`, `Path=/api/refresh`) | A native app has no refresh token, so its session ends with the 15 min access token |
| `POST /api/refresh` | Accepts a body `refreshToken` **but returns the rotated token only in `Set-Cookie`** | A cookie-less caller consumes its token and never learns the successor; its next refresh is reuse and revokes the family. Unusable for native |
| `POST /api/refresh/logout` | Accepts a body `refreshToken`; revokes that row; ends the named installation's push target | Reusable as-is for native logout |
| Rotation (`rotateRefreshToken`) | Postgres: `SELECT … FOR UPDATE` + consume + insert in one transaction. Reuse of a consumed token deletes the whole family. Checks expiry, user existence, `tokenVersion` | Reused as-is. No second refresh-token store |
| `tokenVersion` | `logout-all`, password change/reset, 2FA change bump it; stale access, refresh and media tokens die | Native sessions inherit this |

## 2. Flow

```
App                      System browser (Custom Tab / ASWebAuthenticationSession)        Server
 │ verifier (32 B random), challenge = BASE64URL(SHA256(verifier)), state (16 B random)
 │ store {state, verifier} in memory for this attempt only
 │── open https://<web>/native-auth?redirect_uri&code_challenge&code_challenge_method=S256&state ─▶
 │                         normal web sign-in: password, CAPTCHA, e-mail verification,
 │                         2FA, WebAuthn, SSO (unchanged; produces the bridge_refresh cookie)
 │                         user confirms "Sign in to the Bridge app"
 │                         top-level form POST /api/refresh/native-authorize ───────────────▶ same-origin check,
 │                                                                                   exact redirect match,
 │                                                                                   rotate browser cookie,
 │                                                                                   code (60 s, single use)
 │◀──────────────────── 303 Location: <redirect_uri>?code&state ◀──────────────────────────────
 │ check state == stored state (else drop silently)
 │── POST /api/native-auth/token {code, code_verifier, redirect_uri} ─────────────────────────▶ consume code,
 │◀──────────── {access_token, refresh_token, expires_in, user} (no-store) ◀───────────────── S256 check, mint
 │ refresh_token → SecureStore (Keychain / Keystore); access_token → memory only
```

## 3. Endpoint contract

### `POST /api/refresh/native-authorize` (browser; form-encoded)

Under `/api/refresh` so the path-scoped `bridge_refresh` cookie is sent. It is
the only authentication this endpoint accepts.

| Field | Rule |
|---|---|
| `redirect_uri` | Exact member of `NATIVE_AUTH_REDIRECT_URIS` |
| `code_challenge_method` | `S256` only |
| `code_challenge` | 43 chars base64url |
| `state` | 16–128 chars base64url, echoed unchanged |

| Response | Meaning |
|---|---|
| `303 Location: <redirect_uri>?code=…&state=…` | Success; the browser cookie is rotated in the same response |
| `400` text | Unknown redirect address or malformed request. **Never redirects** |
| `401` text | No/ended/replayed browser session (a replay revokes it, as `/api/refresh` does) |
| `403` text | Not a same-origin submission (`Sec-Fetch-Site` ≠ `same-origin`, or no fetch metadata and `Origin` ≠ `BASE_URL`) |
| `503` text | Not configured, or the code store is unavailable |

All responses: `Cache-Control: no-store`, `Referrer-Policy: no-referrer`.
CSP `form-action` additionally allows the configured redirect origins/schemes,
because browsers apply `form-action` to the redirect after a form POST.

### `POST /api/native-auth/token` (app; JSON)

`{ grant_type: "authorization_code", code, code_verifier, redirect_uri }`

| Response | Meaning |
|---|---|
| `200 {token_type:"Bearer", access_token, expires_in, refresh_token, user}` | Success. No cookies. `no-store` |
| `400 {error:"invalid_request"}` | Shape (verifier must be RFC 7636: 43–128 unreserved chars) |
| `400 {error:"invalid_grant"}` | Unknown/expired/used code, wrong verifier, other `redirect_uri`, user gone, or `tokenVersion` changed since consent |
| `503 {error:"temporarily_unavailable"}` | Not configured or store unavailable |

The code is consumed by the first attempt **whatever its outcome**. A code
presented again within 10 minutes of a successful exchange revokes the refresh
family that exchange created.

### `POST /api/native-auth/refresh` (app; JSON)

`{ refresh_token }`: the same `rotateRefreshToken` as `/api/refresh`, but the
successor is returned in the body, and cookies are neither read nor set.

| Response | Meaning |
|---|---|
| `200 {token_type, access_token, expires_in, refresh_token}` | Rotated; the presented token is now consumed |
| `400 {error:"invalid_request"}` | Missing/oversized token |
| `401 {error:"invalid_grant", reason}` | `reason` ∈ `reuse` (family revoked), `expired`, `revoked` (tokenVersion), `not_found`, `user_not_found` |
| `503 {error:"temporarily_unavailable"}` | Store failure; the token may or may not have been consumed |

### Logout: existing `POST /api/refresh/logout`

`{ refreshToken, push?: { nativeToken } }` → `200 {ok:true}` whether or not the
token was known. Revokes that refresh row and the installation's push target.

## 4. Threat model

| # | Threat | Control | Residual |
|---|---|---|---|
| T1 | Code intercepted on the way to the app (malicious app registered for the same custom scheme, logs, referrer) | PKCE S256; the code is useless without the verifier, single use and 60 s. A wrong-verifier attempt burns it. `no-referrer` | — |
| T2 | **Malicious app starts its own flow** with its own verifier and our custom scheme, and the user confirms | Consent page names the action. **Production should use claimed https redirects** (Android App Links / iOS Universal Links on a host other than the web origin); only the verified app receives them | With a private-use custom scheme this is the RFC 8252 §8.6 residual risk. Choosing redirect addresses is an owner/deploy decision |
| T3 | XSS on the web origin tries to obtain a long-lived native credential | The code is delivered only by a top-level 303 to a non-web-origin address. It is never in JSON. Script cannot read an opaque redirect (`fetch` `redirect:"manual"`) or a cross-origin/external-scheme navigation. `frame-src 'none'` blocks frames. Same-origin https redirect addresses are refused by configuration | XSS can still start a flow, but the code reaches only the genuine app, which drops it (no matching `state`/verifier) |
| T4 | Cross-site request forgery / login CSRF of the consent | `SameSite=Strict` cookie + same-origin fetch-metadata/Origin check. A forged flow's code reaches the genuine app, which has no pending `state` | — |
| T5 | Open redirect | Exact string match against a validated allowlist. Invalid configuration (http, query/fragment, same-origin https, non-reverse-domain scheme, any bad entry) disables the feature | — |
| T6 | Code injection into the app (attacker's code for attacker's account) | App verifies `state`; the exchange needs the app's own verifier | — |
| T7 | Stolen refresh token | Rotation on every use; reuse revokes the family. Stored only in Keychain/Keystore. `logout-all` / password change revoke it | A thief who uses it first and is never followed by the owner is detected only when the owner refreshes |
| T8 | Network failure or crash after the server rotated but before the app stored the successor | **No grace window** (it would weaken reuse detection). The old token is consumed; presenting it is reuse → family revoked → reauthentication | One extra sign-in after such a crash, by design (owner requirement) |
| T9 | Concurrent refreshes from one app | Client single-flight (one in-flight rotation per epoch). On the server a race is reuse, which ends the session (fails closed) | — |
| T10 | Session revoked server-side (logout elsewhere, password change) | Refresh returns `401 invalid_grant reason=revoked`; client clears storage | — |
| T11 | Account confusion (A's response used as B's) | Codes are bound to user + `tokenVersion`; the client's session epoch fences every response | — |
| T12 | Store outage (Redis) | Codes live in the authoritative store only; with `REDIS_URL` set and Redis down, consent/exchange return 503 rather than using process memory | — |
| T13 | Spoofable signals | No User-Agent, custom header, embedded client secret, IP or device attestation is used as a boundary | — |

Not covered here (future, owner decision): device-bound tokens (DPoP or
attestation-bound refresh), per-device session listing with names, and
reuse-revocation of the native family when the *browser* cookie used for
consent is later found stolen.

## 4a. Verified callback links (T2 / security review finding 1)

A private-use scheme (`com.bridge.nativepilot:/oauth`) can be registered by any app, so
T2 remains open while it is the redirect. The server side of the fix is in
`lib/nativeAppLinks.ts` + `routes/nativeAppLinks.ts`, **off by default**:

- Configure an https entry in `NATIVE_AUTH_REDIRECT_URIS` on a **dedicated host** (the
  validator already refuses the web origin), plus `NATIVE_APP_LINKS_ANDROID_PACKAGE` +
  `NATIVE_APP_LINKS_ANDROID_CERT_SHA256` and/or `NATIVE_APP_LINKS_IOS_APP_IDS`.
- On that host only, the server serves `/.well-known/assetlinks.json` (Digital Asset
  Links for the package/certificates) and `apple-app-site-association` (Universal Links
  limited to the callback path, plus `webcredentials` for an https
  ASWebAuthenticationSession callback). Any other host, including the web origin, falls
  through unchanged, so the web origin never claims a path for an app.
- The callback path on that host renders an inert page for when the OS did not hand the
  link to the app: no script or external resources, never echoes the URL (the code),
  `no-store`, `no-referrer`, `default-src 'none'`, `noindex`.
- Any malformed value disables the whole feature (fail closed).

**Not done, owner/deployment decisions:** choosing the callback domain, its DNS/TLS,
the release signing certificate fingerprint and Apple Team ID; the app side (Android
`intentFilters` with `autoVerify`, iOS `associatedDomains`, and an https redirect in the
sign-in call, which on iOS needs ASWebAuthenticationSession https callbacks, iOS 17.4+).
Server tests (`tests/native-app-links.test.ts`) are contract evidence only, not proof
that Android/iOS verify the association on a device.

## 5. Client obligations (React Native)

- Fresh verifier and state per attempt, kept in memory; discard on completion,
  cancel or app restart.
- Ignore any callback whose `state` does not match a pending attempt.
- Persist the refresh token through the verified secure-storage port before
  trusting the session; if persisting fails, revoke it (`/api/refresh/logout`)
  and report storage failure.
- Access token in memory only.
- Refresh in single flight; persist the successor **before** releasing the
  flight; never retry a refresh with a token the server may have consumed. Any
  `invalid_grant` clears the stored token and asks for sign-in.
- Logout: clear local state first, then revoke server-side; report "server
  sign-out not confirmed" when offline.

## 6. Tests

`server/tests/native-auth.test.ts` covers normal sign-in, 2FA-pending login,
expired access token, rotation, concurrent refresh, replayed refresh token
(crash after rotation), revoked session (logout and logout-all), invalid PKCE
verifier, reused authorization code, redirect mismatch, code expiry, open
redirect attempts, cross-site submission, configuration validation, the
disabled state, cookie isolation and cross-account isolation. These are server
contract tests against the in-memory store. The Postgres atomic rotation path
is covered by the existing `test:pg` suite, not by these tests.
