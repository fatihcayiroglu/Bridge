# P7 B4 — E2EE security boundary and acceptance gaps (2026-10-16)

**Status: NOT IMPLEMENTED as a user-facing end-to-end messaging guarantee.**
This is a source-backed gap audit, not proof of cryptographic confidentiality or a closure certificate.

## What is actually present

- `server/lib/e2e.ts`: authenticated public-key registration and X3DH prekey-bundle routes. Storage and retrieval of a key bundle are **not** evidence that a client generated, authenticated, used or retained the corresponding private keys.
- `server/lib/channelE2EE.ts` and `server/socket/handlers/channelE2EEHandlers.ts`: server-side wrapped-key/channel event scaffolding. `server/socket/handlers/messages-send.ts` has an encrypted-payload path, but the shipped client has no production message E2EE sender/receiver.
- `client/tests/e2ee-truthfulness.test.ts`: checks that the misleading E2EE toggle is not mounted and that ordinary message clients do not use the local-at-rest Web Crypto implementation as message E2EE.
- `server/tests/e2ee-feature-flag.test.ts`: `BRIDGE_E2EE_ENABLED` defaults off; a literal `true` may opt into backend scaffolding. **That opt-in does not certify a working client cryptosystem.**
- `client/js/core/local-first/crypto.ts`: encrypts local device cache. Its protection boundary is at rest on the device, not from the message server or other endpoints.

## Threat model and unproven controls

| Threat / lifecycle | Required control and proof before a user-visible E2EE claim | Presently accepted? |
|---|---|---|
| Curious server operator, compromised server/database, lawful-access request | Client creates ciphertext before network transit; server never receives plaintext, plaintext previews or AI embeddings; real independent-client wire and DB evidence | **NO** |
| Malicious key-directory substitution / impersonation | Authenticated recipient device identity; verifiable identity fingerprint/safety number or a defined key-transparency trust model, rotation and anti-rollback; adversarial key-swap tests | **NO** |
| Lost, stolen or compromised device | Independent device identities, device enrolment/revocation, forward secrecy and post-compromise recovery, key destruction and secure multi-device synchronization | **NO** |
| Group membership changes | Explicit epochs and sender-key rotation on join/leave; removed members cannot read future messages; offline concurrent sends/retries converge | **NO** |
| Offline cache, backups, key reset | Local encrypted secret-key custody, backup/recovery and irreversible loss policy; no silent plaintext downgrade on missing keys | **NO** |
| Files, calls, federation and notifications | Individually documented cryptographic boundaries; ciphertext attachment handling and metadata minimization; no unsupported blanket “all messages/files/calls” claims | **NO** |
| Moderation and abuse reports | Define E2EE reporting via voluntary plaintext disclosure, no server-side plaintext AutoMod on ciphertext; consent, audit and safety tradeoffs tested | **NO** |

Even a correct content encryption protocol does **not** conceal participant identities, message timing, channel membership, sizes, IP addresses, or abuse-related operational metadata unless separately protected. An on-device malware compromise and malicious recipient remain outside a server-oblivious content guarantee.

## Immediate truthful-product controls in this PR

- `GET /api/mobile/info` returns `features.e2ee = false` even when the operator sets `BRIDGE_E2EE_ENABLED=true`; the server flag cannot by itself certify end-to-end encrypted messages.
- Public README, landing page and team-marketing claims no longer promise default/native E2EE.
- `/api/e2e/feature-status` formerly exposed the server-side opt-in flag, which could show a misleading E2EE toggle if mounted. Follow-up B4 capability fix makes `enabled=false` until a genuinely implemented client cryptosystem exists. The separate socket-level `BRIDGE_E2EE_ENABLED` switch remains an experimental backend opt-in, **not** proof of E2EE.
- Preserve backend key scaffolding and migration data; do **not** remove fields, enable unimplemented crypto, or claim local-at-rest AES-GCM is message E2EE.

## Mandatory closure evidence (not run or passed by this document)

1. Define a versioned protocol/security design and device-identity trust bootstrap; obtain specialist cryptographic review.
2. Implement client-side encrypt/decrypt for DM/channel delivery with authenticated key distribution, no silent plaintext fallback, and explicit per-conversation state.
3. Prove message ciphertext over the wire and in PostgreSQL, adversarial substituted key tests, group revocation/rotation, offline multi-device, crash/reinstall and backup cases.
4. Define moderation/reporting, file, notification, voice and federation boundaries separately.
5. Run **exact-head** client/server/e2e tests, live PostgreSQL, five-platform CI, negative controls, zero skipped required tests, and reproducible external device evidence where applicable. Record CI run IDs; a skipped or unexecuted job is not PASS.

P7 B4 remains **OPEN** until those gates or an explicitly accepted reduced scope are reviewed. A green test of truthful capability advertising is not E2EE implementation.
