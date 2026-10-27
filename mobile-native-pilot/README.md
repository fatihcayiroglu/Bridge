# Bridge React Native pilot — isolated development candidate

This Expo SDK 57 / React Native 0.86 pilot is separate from the operational
Capacitor client. P7 remains OPEN. No production replacement, merge or deployment
is authorized by its tests. Abuse Lab B1 is unchanged.

## Current executable path

The configured app now restores a native session or opens system-browser PKCE
sign-in, lists real communities/channels, reads message history, receives
Socket.IO events and submits optimistic messages through the memory-only outbox.
It displays queued/sending/confirmed/failed/unconfirmed state, a connection
indicator and explicit stable-ID retry. Reconnect flushes unattempted drafts and
refreshes selected history; uncertain sends are not blindly replayed. Account
transitions clear prior messages/drafts and fence asynchronous results. The
controller also fences channel changes and deduplicates history/live events by
server message ID, never by equal content.

Without EXPO_PUBLIC_BRIDGE_ORIGIN the app displays configuration instructions and
does not choose a server or show fixture messages. With a configured origin it
connects when launched: use a disposable test installation, not production data.

## Run on a suitable native development machine

1. `npm ci` in this directory (Node >=22.19.0).
2. Configure `EXPO_PUBLIC_BRIDGE_ORIGIN=https://your-test-host` (origin only,
   no trailing slash/path/credentials). Never embed access or refresh tokens.
3. Register exactly `com.bridge.nativepilot:/oauth` in the test server's
   NATIVE_AUTH_REDIRECT_URIS. Set its actual HTTPS BASE_URL/ALLOWED_ORIGINS.
4. Use a CA trusted by that device. Never disable TLS validation.
5. `npm run android` / `npm run ios` using the native SDK/Xcode toolchain. Sign in
   in the system browser; there is no shared password embedded in the app.

Refresh tokens use the existing Expo SecureStore port (device-only unlocked
Keychain policy and Android backup exclusion); access tokens stay in memory.
Rotation/reuse, CSRF, cookie isolation and code/state/verifier checks are retained.
Production redirect policy should use claimed App/Universal Links; this pilot's
custom scheme still requires physical-device security acceptance.

## Reproducible real-backend CI

`.github/workflows/native-pilot-backend-integration.yml` checks out the exact
candidate head and verifies that it contains both pinned parents:

- #518 backend: `e7de5d5c957d6d36691de1b501825df6e17599a2`
- #521 pilot: `51c95a75ae232912806d1208c178eae8c8d61228`

It creates disposable PostgreSQL **16** and Redis **7** service containers with no
host volumes, checks their real identities, installs committed lockfiles and
audits dependencies without suppressions. Random JWT/refresh secrets and a
one-day local CA/certificate are generated on the runner, not committed or
uploaded. The fixed loopback HTTPS/WebSocket proxy exposes the actual backend
at `https://127.0.0.1:8443`; NODE_EXTRA_CA_CERTS trusts only the generated CA.
NODE_ENV is development, so no mock database path is used. Test-volume rate
quotas are explicit; authentication and authorization remain enabled.

Run **40570266589**, head `792d1f90`, passed the original **15/15** real-backend
tests with **0 failed/cancelled/skipped/TODO**, including actual PKCE exchange,
refresh rotation/reuse, account transitions, offline draft, lost ACK, reconnect,
same-ID replay, concurrent duplicate sends and cross-account ACK namespace.
Independent PostgreSQL queries found **1** lost-ACK message and **0** duplicate
`(userId, ackId)` groups. Pilot checks also passed on run **40570266447**.

The subsequent UI controller adds a sixteenth backend test: a real authenticated
session selects a channel, sends through the same controller as the screens and
reconciles the canonical persisted message. Its final CI status must be checked
on the exact final head; the earlier 15-test pass alone does not qualify new code.

Artifacts are retained by unique run/attempt name for seven days. Test failures
are not retried. The summary parser requires exactly 16 tests and zero skipped,
cancelled or TODO cases. A separate SQL query checks database persistence.

For manual backend tests set actual BRIDGE_IT_ORIGIN/BRIDGE_IT_REDIRECT and
NODE_EXTRA_CA_CERTS, then run `node --test integration/native-auth-backend.it.mjs`.
Missing configuration fails. `integration/token-expiry.it.mjs` separately needs
a matching short ACCESS_TOKEN_TTL / BRIDGE_IT_ACCESS_TTL_S server setup.

## Remaining acceptance

- This outbox is **memory-only**: process termination loses drafts. Durable
  encrypted local persistence/recovery is not implemented; exactly-once delivery
  is not claimed. Replay IDs are retained for at most 256 distinct sends per
  account epoch; reaching that pilot limit is an explicit error.
- Node contracts and real backend tests do not exercise native rendering,
  Keychain/Keystore, Custom Tabs/ASWebAuthenticationSession, backup/uninstall,
  permission prompts or real radio interruption. APK/IPA and physical-device
  acceptance remain required.
- Initial history is limited to 50 messages. Pagination, edit/delete/reaction
  synchronization, attachments, push, calls and full client parity remain open.
- No startup/frame/ANR target is established by JS bundle export. Measure <1 s
  meaningful UI and <2 s usable UI on identified physical devices. #209/#416
  remain open; intermittent green runs are not root-cause fixes.

Historical development receipts are in CONTINUATION-2026-10-27.md,
FOLLOWUP-2026-10-27.md and evidence/. Those describe their original heads and
are not automatically fresh results for this integration candidate.
