# P7 C4 — Pinned Ed25519 source manifest attestation (foundation)

**Status: offline pure verifier only. No issuing route, no trust registry, no
transactional source snapshot, no import/apply, no durable approval.**

`server/lib/portableSourceAttestation.ts` validates a signed *pair* of
**already checksum-valid** structure and permissions manifests. Its signature
is bound to the two manifest SHA-256 digests, source identity, HTTPS origin,
declared source snapshot ID, issuance/expiry times and public key fingerprint.

The public key is **supplied independently by the destination operator**;
never discover or trust a key embedded in the submitted artifact, from the
untrusted origin URL, or through unauthenticated key rotation. Use external
administrative key pinning and out-of-band ownership verification before
adopting a key. Revoking a key means removing it from the independently
approved trust store; that store is **not implemented** in this slice.

## Attestation schema

```json
{
  "format": "bridge-portable-community-source-attestation",
  "version": 1,
  "sourceOrigin": "https://source.example",
  "sourceServerId": "source-id",
  "snapshotId": "source-snapshot-token-of-16-plus-chars",
  "structureDigest": "64 lowercase hex characters",
  "permissionsDigest": "64 lowercase hex characters",
  "issuedAt": "2026-10-12T12:00:00.000Z",
  "expiresAt": "2026-10-12T12:05:00.000Z",
  "keyFingerprint": "sha256 of trusted Ed25519 public key SPKI DER (64 lowercase hex)",
  "signature": "base64url without padding: Ed25519 signature (64 bytes)"
}
```

The signed byte string is the UTF-8 prefix
`bridge-portable-source-attestation-v1\n` followed by JSON containing the
ten unsigned schema fields in the fixed implementation order. Signing uses
Ed25519 with no prehash. Input must have *exactly* the declared keys.

- Exact pinned key fingerprint and HTTPS origin must match.
- Both separately validated manifests must share the same source server ID.
- Digests must match the signed pair; a recomputed self-checksum after
  tampering will not pass the signature check.
- Reject forged signatures, non-Ed25519 keys, alternate encodings, malformed
  dates, future claims over 5 minutes ahead, and expiry beyond 24 hours.
- On ANY error, return one generic `PORTABLE_SOURCE_ATTESTATION_INVALID`
  exception without exposing how far attacker-controlled verification got.
- On success, return `sourceSignatureValid: true` **and**
  `snapshotAtomicityVerified: false`,
  `importSupported: false`, `mappingApproved: false`, and
  `writesPerformed: false`.

## What this does NOT prove

A signature means **only** that the holder of the *independently pinned*
source key attested the two submitted digests. It does **not** establish that
both files were read in one transaction, that the source was honest,
that the destination still matches the mapping review, that the target owner
approved use, that the attestation is unused, or that any writes are safe.

Source signing/issuance must later run against a versioned consistent
PostgreSQL source snapshot with a durable per-instance signing identity.
Trust bootstrap, key rotation/revocation, durable single-use approvals,
serializable destination apply, rollback/failpoint evidence, and two
independently deployed installations are tracked in
[issue #205](https://github.com/fatihcayiroglu/Bridge/issues/205).

This offline module is not mounted in a server route and must **not** be used
as an import capability until the remaining steps are implemented and tested.
