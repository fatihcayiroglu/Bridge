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

## Local setup on a suitable development machine

1. Use Node.js >=22.19 and a supported Android SDK or macOS/Xcode (for iOS).
2. In `mobile-native-pilot`, run `npm install` and `npx expo install --fix`
   to resolve SDK-compatible package versions. Commit a generated lockfile only
   after confirming the exact dependency graph and successful builds.
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
