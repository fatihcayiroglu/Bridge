# P7 C4 — fresh account.import step-up on the locked owner transaction

**UNMOUNTED SECURITY GUARD. Does NOT authorize or perform an import.**

The existing step-up system issues signed short-lived credential grants, but
those grants are only meaningful together with the *current* account version
and two-factor state. A detached `Users.findById` or a permissive rollback
switch is not sufficient for an irreversible community change.

`requireLockedPortableOwnerStepUp` accepts ONE caller-owned PostgreSQL client
which MUST already be in a `SERIALIZABLE READ WRITE` transaction. It reads
and locks the current user row (`tokenVersion`, `twoFactorEnabled`) in that
client, checks the same PostgreSQL transaction ID before and after the
user read (serializable autocommit is NOT an acceptable substitute for a
caller-owned open transaction), then validates the signed `account.import`
scope via the existing
`checkStepUpGrant` cryptographic verification. The scope must be current,
for the exact owner ID, sufficient for current 2FA requirements and issued
within the previous **120 seconds**. It rejects missing, forged, expired,
wrong-scope, invalid-version, recently revoked, over-age and future-issued
grants. It **never consults STEP_UP_DISABLED_SCOPES**.

A compromised credential proof is still NOT explicit destination owner
consent to *specific source mapping choices*. The result therefore includes
`stepUpVerified:true` but always
`consentVerified:false`, `tokenIssued:false`,
`writesPerformed:false` and `importSupported:false`.
No bearer secret or user credential leaves this helper.

The eventual import-approval transaction must run this helper and the #222
locked signed source/destination review on the same physical client, require
owner confirmation for the complete specific source-to-target mappings, and
insert the #223 short-lived token before COMMIT. The apply transaction must
redo all owner/step-up/source/key-revocation/topology/permissions checks
before a one-use claim and all writes, with redacted audit and failpoint
rollback proof. No route is added in this PR.

The live PostgreSQL test proves a concurrent token-version update is blocked
while the client holds a row share lock and checks that changed versions and
current two-factor requirements fail closed.

Issue #205 remains OPEN. Do not claim P7 C4 complete.
