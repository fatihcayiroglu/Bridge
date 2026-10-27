# Bridge Native Android/iOS Pilot (experimental; NOT a replacement client)

This folder starts a separate React Native / Expo render experiment while Bridge P7 remains open.
It must not replace the existing Capacitor application, write to production data, or be
used as evidence that authentication, messaging, offline sync, uploads, or calls work.

## Isolation and known limitations

- App identifiers are `com.bridge.nativepilot`; the URL scheme is `bridge-native-pilot`.
- Only native layout fixtures are shown. There is **no server connection**, no auth,
  no message sending, no persistence, no push, and no media.
- JS `first_layout` means React Native layout callback, **not actual first paint**.
  Measure Android TTID/TTFD, focus ANRs and FrameTimeline with platform tracing;
  measure iOS launch and frame stability with Instruments. No timings here are a pass gate.
- The package is independent of Bridge's existing npm workspace and lockfile.
  Expo SDK 57 / RN 0.86 is a pilot choice, not a product framework decision.
- The SDK/toolchain and device build have **not been installed or validated** in this
  cloud environment. Do not describe this as an APK/IPA or working acceptance build.

## Dormant read-only HTTP contract (not wired to the app)

`src/bridge-read-api.mjs` now provides an injectable read-only bridge for the existing
`/api/me`, `/api/servers`, `/api/servers/:sid/channels`, and
`/api/channels/:cid/messages` endpoints. Its Node contract tests use fake HTTP responses:
**they are not real backend, native networking, permission, or performance tests**.
The adapter deliberately requires HTTPS and an externally supplied, memory-only
`{ token, epoch }` session snapshot. The epoch MUST change after login, logout,
or account switch; responses from an older snapshot are rejected. It does not
persist tokens, implement login/2FA/WebAuthn, send messages, reconnect sockets,
perform an automatic retry, or touch user data. No Bridge account is used.
The React Native fixture screens do not call this adapter. Connecting them is
blocked on native secure credential storage, a session lifecycle contract,
real integration tests, and explicit owner-reviewed acceptance gates.

## Native credential capability (dormant; no sign-in yet)

The pilot declares Expo SDK 57's `expo-secure-store ~57.0.4` and its Android
backup-exclusion config plugin. `src/expo-credential-port.ts` injects Expo
SecureStore into a fail-closed, testable port. The port uses a pilot-only key,
requires native availability, applies iOS unlocked-this-device-only access,
and serializes reads, writes and deletion so an in-flight write cannot overtake
a later logout deletion. There is no AsyncStorage, file or plaintext fallback.
No login screen imports or invokes this port; **no real credentials have been
read or stored by this change**.

These are Node tests with a fake secure-store object, not Keystore/Keychain
proof. On iOS a Keychain item can survive app uninstall/reinstall; therefore
a future real session implementation must validate any restored token with
`GET /api/me`, support explicit revocation, invalidate account epochs before
logout, and handle failed native deletion without claiming logout complete.
Native device uninstall, backup/restore, passcode/biometric and multi-account
behaviors remain open and BLOCK any production replacement.

## Session lifecycle (contract-tested; no screen wired yet)

Sign-in uses the system browser (Android Custom Tabs / iOS
ASWebAuthenticationSession, ephemeral) and authorization code + PKCE (S256)
against the server endpoints described in `docs/NATIVE_AUTH.md` on the server
branch. The web page keeps enforcing password, CAPTCHA, e-mail verification,
2FA, WebAuthn and SSO. `src/session-coordinator.mjs` then:

- persists only the rotating refresh token, through the credential port;
- keeps the access token in memory;
- refreshes in single flight;
- persists each successor before using it;
- fences every account transition with an epoch;
- clears locally before revoking server-side, and reports
  `serverSignOut: confirmed | unconfirmed`.

After a crash or lost response between a server rotation and local
persistence, the next refresh is reuse: the server revokes the session and the
user signs in again. Reuse detection is not relaxed.

The tests are Node contract tests over fakes (SecureStore, fetch, browser).
They are not Keychain/Keystore, system-browser, backend or device evidence.
The server endpoints must be deployed and `NATIVE_AUTH_REDIRECT_URIS`
configured before any device test. For the pilot, the redirect address is the
private-use scheme `com.bridge.nativepilot:/oauth` (declared in `app.json`).
Production should use verified App Links / Universal Links instead: another
installed app can claim a custom scheme (docs/NATIVE_AUTH.md, T2).

## Real-backend integration (manual; not device evidence)

`integration/native-auth-backend.it.mjs` drives the pilot's own modules against a running
Bridge server with native auth (server PR #518) on real PostgreSQL and Redis:
browser-sign-in, native-auth-api, session-coordinator, the credential port and the read API.
Only the system browser (an HTTP client doing what the web consent form does) and
SecureStore (in-memory) are simulated. It is not `npm test`, and a missing
configuration fails it; it never skips.

Server settings the run needs:
- `NATIVE_AUTH_REDIRECT_URIS=com.bridge.nativepilot:/oauth`
- `BASE_URL` and `ALLOWED_ORIGINS` set to the HTTPS origin
- `NODE_ENV` other than `test`, so the atomic PostgreSQL rotation path is used
- for repeated runs from one IP, raised test limits: `MAX_REG_PER_HOUR`,
  `RL_REGISTER_MAX`, `RL_LOGIN_MAX`, `RL_REFRESH_MAX`, `RL_2FA_MAX`. With the defaults,
  the 2FA limiter (5 per 5 min) answers 429 on the third consecutive run.

```
BRIDGE_IT_ORIGIN=https://localhost:8443 BRIDGE_IT_REDIRECT=com.bridge.nativepilot:/oauth \
NODE_EXTRA_CA_CERTS=ca.crt node --test integration/native-auth-backend.it.mjs
```

Recorded 2026-10-27: #518 head `2a212ae8`, PostgreSQL 16, Redis, behind a local HTTPS
proxy. 10/10 in three consecutive runs, covering:
- sign-in, rotation, real reuse detection, concurrent single-flight, a raw double-spend;
- code replay and wrong verifier; unlisted redirect and foreign state;
- 2FA (no code before the second factor); restore after restart;
- logout (server confirmed); logout-everywhere from the web; account switch;
- no refresh token in browser JSON and no cookies on native responses.

Negative control: with native auth unconfigured on the server, 0/10.

## Local setup on a suitable development machine

1. Use Node.js >=22.19 and a supported Android SDK or macOS/Xcode (for iOS).
2. In `mobile-native-pilot`, run `npm ci` (the lockfile is committed; see
   `DEPENDENCY_AUDIT.md` for the open audit finding).
3. Run `npm test`, `npm run typecheck`, then `npm run android` or `npm run ios`.
4. Benchmark **release builds** on real Android/iOS devices before interpreting
   performance; development-mode results do not count.

## Next steps (no fake-green acceptance)

1. Compare bare RN and Expo development-build native integrations (CallKit/PushKit,
   Android Telecom, Keystore/Keychain, SQLite, react-native-webrtc/mediasoup).
2. Extract typed API/auth and message/offline contracts into framework-neutral TS;
   explicitly remove DOM/global window dependencies at the adapter boundary.
3. Implement functional sign-in, channel list and send/receive/offline queue using
   the **real Bridge backend**, without recording credentials in CI artifacts.
4. Test deep links, account separation, permission handling, upload, WebRTC calls,
   and reconnect on **physical** Android and iOS devices.
5. Compare 30-50 controlled cold starts per arm to begin assessing reliability;
   use longer real-device runs for robust ANR rate estimation. Report p50/p95/p99
   TTID, TTFD, first useful UI, interaction latency, memory, GPU time, battery,
   and failures under identical workloads. Owner targets are <1 s meaningful UI
   and <2 s interactive on an agreed reference device. Never weaken existing
   Capacitor assertions or relabel conditional/empty tests as PASS.

## Scope guard

The pilot is intentionally additive, distinct from production `main` integration
and from the P7 release candidate. No PR merge or release is authorized here.
The protected Abuse Lab B1 files must remain untouched. Tests use 0 retries and
must count skips explicitly. React Native replaces Capacitor only after functional
parity and real-device gates are proven and the owner authorizes a rollout.
