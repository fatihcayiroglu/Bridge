# D2 voice transcription admission and recovery

The integrated D2 candidate protects message writes, but `voice_messages` had no channel-expiry trigger. Real PostgreSQL tests on parent `7e38d274` accepted raw inserts into expired, tombstoned, corrupt-expiry and other-tenant channels, accepted transcript updates after expiry, and accepted writes after a later upload-reference lock wait or from a stale repeatable-read snapshot. Separately, exact account anonymization was refused on expired messages and threads because the erasure exception did not recognize the established `deleted-user` identity.

The real HTTP pipeline also revealed that ordinary access tokens do not contain `displayName`: message persistence failed its PostgreSQL NOT NULL constraint. Once that was corrected in isolation, tests reproduced audio offload after expiry during the server-policy read, persistence of a late transcript, and publication to a room different from the canonical membership room.

## Implementation

- Voice posts resolve the stored author snapshot after channel permissions, membership and timeout checks. Both standard and valid id-only JWTs use stored identity data.
- Background transcription reuses `channelLiveForMedia` before provider offload, after the provider returns and before publication. Unverifiable authority fails closed. The event targets the existing `channel:<id>` room.
- Migration **096** attaches the existing 086 BEFORE admission function and 092 AFTER statement-admission function to voice rows. No second expiry policy, cleanup worker or storage protocol is introduced. These ordinary triggers cannot be deferred; final admission checks authority after upload/index lock waits and rejects stale snapshot authorization.
- The shared erasure predicate recognizes changes to `userId`/`createdBy` only to the established `deleted-user` identity, with every present author snapshot cleared to account-erasure policy values. The existing per-column validation still rejects coupled new transcript/content/title, arbitrary author reassignment and incomplete identity scrubbing.

Migration slots **093–095** already belong to the existing #502 review branch (thread reporting, account-erasure indexes and thread final admission). This branch reserves them rather than duplicating that work. There are **93 migration files**, ending at 096, on this stack. 096 requires 086 and 092. A future integration with 095 must retain both later dependants when classifying/reversing 092; unwind 096 and 095 before 092.

## Recovery contract

096 is schema-only. Its down removes only its two voice triggers and restores 086's exact prior erasure-function definition. It never drops or rewrites voice data, retained moderation evidence, tombstones, upload reservations or pending release entries. Down removes the new protections; roll forward to restore them. Isolated reversal of 086/092 correctly refuses to drop shared functions while 096 depends on them. Exact measured dependency classifications describe those errors; the ordered rollback gate remains mandatory.

The dedicated real PostgreSQL migration test compares exact function/trigger definitions and data before/after down/up and replay, and verifies that SET CONSTRAINTS cannot bypass admission. The schema comparison includes columns, constraints, indexes, functions, triggers, table access and policies. The original synthetic pre-D2 upgrade fixture remains hash-identical through the additional migration.

## Test boundaries and remaining acceptance

Unit tests control provider/policy boundaries. HTTP integration uses actual JWT verification, PostgreSQL, Redis, private S3-compatible uploads and multipart HTTP provider traffic. Only the provider destination and selected race boundaries are controlled; no SQL or storage admission is mocked. Socket principals enter the real membership join handler, with an authorized recipient and other-tenant negative control; this is not full socket-authentication acceptance or speech-recognition quality evidence. An ordered sentinel drains prior network events before absence assertions.

The database controls use independent transactions and observed PostgreSQL lock waits. Late transcripts cannot bypass the SQL barrier. The tests do not kill a process or establish production performance. Audio already admitted to a provider cannot be recalled; this change rechecks current channel authority before initiating offload and refuses results/publication after expiry. The two legacy voice/message writes remain separate transactions; durable pre-upload intent and all crash-compensation boundaries remain separate acceptance work.

No Android/native source, Abuse Lab evidence, cryptography, rate-limit policy, retry budget, timeout, permission rule or coverage threshold is changed. The fixture uses a distinct actor per test to respect the unchanged upload quota. Keep #321/#209/P7 open. This draft stack inherits #375 and must not merge into main or deploy without explicit owner approval and the outstanding reviews/acceptance evidence.
