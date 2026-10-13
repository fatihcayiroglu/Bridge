# P7 C4 — same-client approval staging (internal, unmounted)

**This PR stores a hashed, short-lived, one-use approval record in PostgreSQL,
but still does not expose an HTTP approval endpoint or migrate any community
data.** Import remains disabled. Issue #205 remains open.

`stageOwnerConfirmedPortableApproval` accepts a trusted `ownerId` that must
come from an authenticated server route, not from a request body; it also
requires an explicitly confirmed 64-hex review fingerprint, the signed C2
source manifests and an independently operator-pinned revocable source-key
registry. It enforces a bounded untrusted payload before DB acquisition.

Inside a single `BEGIN ISOLATION LEVEL SERIALIZABLE` physical PostgreSQL
client, it calls the following in order:

1. `requireLockedPortableOwnerStepUp`: current locked user account factor
   state, uncompromised tokenVersion, valid `account.import` scope and
   at-most-120-second-old credential proof, with transaction ID continuity
2. `deriveVerifiedPortableApprovalBinding`: independently pinned Ed25519
   source proof, explicit mapping, current locked destination OWNER,
   complete target topology and all mapped channel permission rows
3. Strict equality between the owner's reviewed fingerprint and the fresh
   verified mapping result — any stale mapping, altered target or substituted
   signed artifact fails with ROLLBACK
4. `insertPortableImportApprovalWithinTransaction`: the same parameterized
   one-use SHA-256-hashed ledger token and expiry cap already used by 081/082
5. `COMMIT`; only **after success** may the internal service return the
   ephemeral token. Failed SQL or COMMIT returns a generic error and attempts
   ROLLBACK. Failed rollback discards the compromised connection.

The former, unmounted independent-pool `stagePortableImportApproval`
continues using the exact same parameterized SQL insertion primitive,
preserving its pre-existing contract. It still does not authenticate consent
and MUST NOT be added directly to any route.

The live PostgreSQL test proves real single-transaction durable issuance,
binding, one-use CAS replay rejection, changed grants and token-version
revocation. Unit tests prove negative guards, no token after failed COMMIT,
and discarded broken connections. No tests are silently skipped.

**Critical limitations:** No mounted route presents or verifies the owner's
actual UI decision. No category/role/channel importer applies the approval;
there is no post-apply parity, atomic failpoint recovery, or two independent
TLS deployments acceptance. The future route MUST verify the authenticated
owner, present every ID mapping and permission consequence, accept an explicit
confirmation action and forward a valid credential grant. A detached preview
or a service call with a self-asserted ownerId is **never authorization**.
