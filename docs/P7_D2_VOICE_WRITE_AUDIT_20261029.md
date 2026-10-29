# P7 D2 voice-message expiry preflight

This child preserves #578 at `ac756d901d5fe48861481ed99f3eb4800ddcb0e1`.
That parent passed run 40789715107 / job 123171605660: 97 unit tests and seven
real PostgreSQL16/Redis tests, zero failed/skipped, types/strict types/build PASS.
The new voice changes require independent exact-head qualification.

The actual voice upload route now uses the canonical channel authority after
membership/timeout/permission checks and before local audio-file creation or
private storage. Gone returns 404; unverifiable canonical state returns 503.
After the private upload completes it reloads the channel and rechecks authority
before creating either voice/message DB reference. A refusal rolls back only
this request's newly uploaded object using the existing cleanup helper; existing
channel/user data is retained. No authentication, B1 or storage security is relaxed.

These are preflight checks, not an atomic transaction spanning channel state,
the two DB tables and external object storage. Expiry/permission changes between
the final check and subsequent writes remain OPEN. Failed external object deletion
is logged by the existing helper; no durable object-cleanup guarantee is added.
The transcript/read path, other message producers, D2 activation/cleanup,
federation and real reconnect/process-restart acceptance remain separate gates.

Five new unit cases cover initially expired/unverifiable state, a valid future
expiry, expiry during private upload, and lost authority after upload. Local
voice suites: **3 suites / 43 tests PASS**, zero failed/skipped. Storage in these
unit tests is explicitly mocked; they prove cleanup invocation, not real S3
object deletion or genuine audio recording/playback.

The real PG/Redis suite gains an actual authenticated HTTP request with a signed
fixture JWT, the production auth middleware, a persisted user/membership/channel
and a multipart audio fixture. It requires an expired channel to return 404 with
no local voice file and no voice/message row. The fixture is not a genuine
recording/codec test or an interactive login journey. No authentication middleware
is mocked. The inherited PG16 workflow now also executes all three voice suites.
New exact-head CI remains pending at preparation; do not copy the parent's seven
PG passes onto the new eight-test suite.

P7 and #321 remain OPEN. The writer inventory in
`P7_D2_SCHEDULED_WRITE_AUDIT_20261029.md` describes the earlier parent; this document
updates only the voice-route row, not the remaining open writers.
