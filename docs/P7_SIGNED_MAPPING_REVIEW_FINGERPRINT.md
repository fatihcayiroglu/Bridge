# P7 C4 — verified source + destination mapping review fingerprint

**Status: read-only and non-authorizing.** This slice combines the signed
source proof introduced in #211/#215/#217 with the explicit destination ID
mapping review introduced in #197/#203. It still issues **no approval** and
performs **no migration writes**.

## Endpoint

`POST /api/servers/:sid/portable-import/signed-mapping-review`

The destination OWNER must authenticate and present a fresh
`account.import` step-up proof. The deployment must explicitly enable the
independently pinned source keyring documented in
[P7_DESTINATION_SOURCE_ATTESTATION_REVIEW.md](P7_DESTINATION_SOURCE_ATTESTATION_REVIEW.md).
There is no trust-on-first-use and no source public key from the request.

Request fields (exactly):

```json
{
  "structure": {},
  "permissions": {},
  "attestation": {},
  "expectedSourceOrigin": "https://source.example",
  "expectedSourceServerId": "chosen-source-server-id",
  "targetServerId": "authenticated-target-sid",
  "mapping": {
    "targetServerId": "authenticated-target-sid",
    "structureDigest": "64 lowercase hex",
    "permissionsDigest": "64 lowercase hex",
    "expectedTargetDigest": "64 lowercase hex",
    "categories": [{ "sourceId": "source-category", "targetId": "existing-target-category" }],
    "roles": [{ "sourceId": "source-role", "targetId": "existing-target-role" }],
    "channels": [{ "sourceId": "source-channel", "targetId": "existing-target-channel" }]
  }
}
```

Both manifests, signer and source identity must pass the revocable
operator-pinned Ed25519 trust policy. Independently, the current target
topology is read from authenticated destination repositories and must match
the explicit `expectedTargetDigest`. All source-to-target links are
one-to-one, existing and type-compatible. Role permission widening and
unsupported source overrides are identified.

## Deterministic review fingerprint

The `reviewFingerprint` is SHA-256 of a domain-separated JSON encoding
with fixed field order. Its input includes the exact source origin, source
community, attestation snapshot ID, signing key fingerprint, signature
expiry, both manifest digests, destination server ID and topology digest,
all canonical sorted category/role/channel links, and the measured risky
role-mapping/unsupported permission counts. Changing any of these decisions
changes the review fingerprint. No sensitive registry, message contents,
member roster or signing keys are returned.

The review also reports the source signature's validity, conservative
mapping risks and blockers. In particular **every** successful response
continues to state:

- `approvalEligible: false`, `mappingApproved: false`
- `importSupported: false`, `writesPerformed: false`
- `transactionallyLocked: false`, `targetSnapshotAtomicityVerified: false`
- `targetTopologyBound: true` means **ONLY** bound in this read-only evidence
  digest, not a transactional revision lock.
- `SIGNED_MAPPING_REVIEW_IS_NOT_APPROVAL` remains a blocker.

The review hash is predictable/reusable and **cannot be used as a bearer
capability, durable consent, replay lock or import authorization**.
Destination topology is read through multiple repository calls, not one
serializable write transaction. An attacker could cause edits after this
read-only response, so an eventual importer MUST re-check all owner/identity,
signature, permission, mapping and target state inside its own locked DB
transaction.

## Remaining P7 C4 requirements

A durable single-use owner approval with expiry, an atomic SERIALIZABLE
destination apply/rollback, a consistent current permission-grant check,
per-instance key rotation and independently deployed source/target
end-to-end transfer evidence are NOT implemented. They remain tracked in
[issue #205](https://github.com/fatihcayiroglu/Bridge/issues/205).

Exact-head CI includes a real Ed25519 pairing test with an independently
provisioned registry, stale-target and permission-widening regressions,
authenticated owner/step-up HTTP checks, and the existing live PostgreSQL
snapshot test from #213. No existing coverage or skip gate is reduced.
