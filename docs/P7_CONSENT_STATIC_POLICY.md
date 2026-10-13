# P7 C4 — static permission barriers before future consent

This **unmounted, read-only** gate rechecks the signed mapping review with
independently operator-pinned Ed25519 keys, and validates the complete source
structure and permission manifests. It does not issue an approval token.

`inspectStaticPortableImportConsentPolicy` reports only whether static
source/mapping constraints are conservative enough to **consider** a future
owner-consent workflow. It fails closed on revoked or forged signatures,
stale destination fingerprints, partial/duplicate ID mappings, permission
widening, omitted legacy/user grants, or privileged role/channel permission
bits (MANAGE_ROLES and ADMINISTRATOR). New unfamiliar mapping blockers also
prevent positive static evidence.

Even on `staticChecksPassed: true`, the result ALWAYS has:
- `consentSupported: false` and `consentIssued: false`
- `writesPerformed: false` and `importSupported: false`
- `liveTargetPermissionGrantsVerified: false` and
  `destinationRevisionLocked: false`.

The destination topology digest does not include target channel permission
override rows or `@everyone` grants. The source signature cannot prove the
remote deployment really used an MVCC snapshot; it only proves the pinned
source signer attested the contents. A recurring review fingerprint is not
one-time consent.

**Future implementation must** collect explicit owner consent under fresh
`account.import` step-up, recheck owner and source-key revocation,
read destination topology + grant permissions on one locked PostgreSQL
transaction, verify semantic equivalence/non-escalation, and only then stage
the 081 approval ledger. A separate SERIALIZABLE importer must revalidate
that complete trust and permission policy inside the *same* physical client
that claims the one-time approval and applies all writes.

The `staticChecksPassed` output must NEVER be treated as authorization to
invoke `stagePortableImportApproval`. This code does not close issue #205.
