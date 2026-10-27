# Native sign-in and token handling: review of the pilot (2026-10-27)

Scope: the RN pilot at `3e1a4824` (stack #524 → #527 → #529) and the server contract in
#518 (`docs/NATIVE_AUTH.md`). This is a code and configuration review. It is NOT device
evidence. Custom Tabs, ASWebAuthenticationSession, Keychain and Keystore behaviour still
need physical Android and iOS runs.

## Verified in code
| Area | Finding |
|---|---|
| Callback acceptance | `browser-sign-in.mjs` accepts only the `openAuthSessionAsync` result. It requires an exact `redirectUri + '?'` prefix, no fragment, no duplicate parameters, and a constant-time state match. It never reads `Linking` URLs. |
| Code injection | A foreign code fails the state check before any request. A code without our verifier is burnt server-side. |
| Origin | Every adapter refuses non-https origins. `EXPO_PUBLIC_BRIDGE_ORIGIN` is not trusted unvalidated. |
| Storage | The refresh token and the outbox DB key are in SecureStore, `WHEN_UNLOCKED_THIS_DEVICE_ONLY` on iOS and Keystore on Android. Android `allowBackup: false` plus `configureAndroidBackup: true` keep both out of backups. |
| Memory | The access token is in memory only. Emitted session state never carries a token (coordinator tests). |
| Logging | The one runtime `console.warn` is in the debug-only acceptance probe, and it redacts 64-hex key material. No other source file logs. |
| Reuse | Rotation has no grace window. A crash after rotation leads to reuse, then sign-in again (tested on real PostgreSQL). |

## Open findings (need owner or deployment decisions; nothing changed here)
1. **Custom-scheme interception (high, before production).** Any installed app can
   register `com.bridge.nativepilot`. On Android, Custom Tabs then offers an app chooser
   for the callback. PKCE and state stop injected codes, but not a malicious app that
   starts its own flow and receives the user's consent (RFC 8252 §8.6; T2 in
   docs/NATIVE_AUTH.md). Fix: an https App Link / Universal Link on a host other than the
   web origin, plus `assetlinks.json` / `apple-app-site-association`, registered in
   `NATIVE_AUTH_REDIRECT_URIS` instead of the custom scheme.
2. **Unused second scheme (low).** `bridge-native-pilot` is registered in `app.json` but
   no sign-in path uses it. Remove it unless a deep-link feature needs it; every extra
   scheme widens what other apps can send in.
3. **Android has no ephemeral browser session (medium, UX/security).** iOS uses
   `preferEphemeralSession`. Android Custom Tabs shares the Chrome profile, so an existing
   Bridge browser session goes straight to the consent dialog. That dialog (which names
   the account) is the only gate. Confirm it on a physical device, and decide whether
   consent should require a fresh password or step-up for native authorization.
4. **No device binding (medium, future).** A stolen refresh token works from any device
   until it is rotated or revoked. DPoP or attestation-bound refresh is a backend
   decision (docs/NATIVE_AUTH.md, "Not covered").
5. **Keychain survives an iOS uninstall (medium).** A reinstalled app can find a previous
   refresh token. The coordinator validates it with the server before use, but there is
   no first-launch purge. Decide whether a fresh install must start signed out, then
   test on a device.

## Required device checks (not done)
- Custom Tabs and ASWebAuthenticationSession round trip with the real redirect address.
- Behaviour when a second app registers the same scheme (Android chooser).
- SecureStore across background, restart, OS upgrade, uninstall/reinstall and backup/restore.
