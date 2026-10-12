# P7 C4 — Destination operator-pinned source keyring

**Status:** Offline verifier and regressions ONLY. There is no new route,
destination owner approval, import, table mutation, or automatic source discovery.

The source exporter from PRs #211/#213 and draft #214 signs a pair of
portable community manifests with Ed25519. The receiving independent
installation MUST independently establish and maintain which signing public
keys belong to which HTTPS source origins before accepting a downloaded pair.
A valid signature with an attacker-provided public key is not authentication.

`server/lib/portableSourceKeyring.ts` defines a bounded, operator-supplied
keyring and a verifier combining the existing strict signature verifier with
key lifecycle checks. The caller, **not the untrusted artifact**, provides the
trusted source origin and registry JSON. The library makes no outbound
connections and has no migration or authorization side effects.

## Independent operator provisioning

Supply the registry only through trusted destination administrator
configuration, *outside* the HTTP request, submitted manifests, source
server responses, browser storage, URL headers, DNS, or dynamically downloaded
JWKS documents. A future deployment integration must choose a secret-manager
or admin-managed config file, check access permissions and audit updates.
This slice does **not** implement that integration or a persistent trust API.

For example, after verifying a source's possession/ownership separately,
an administrator can prepare the following policy:

```json
{
  "format": "bridge-portable-source-trust-registry",
  "version": 1,
  "keys": [
    {
      "sourceOrigin": "https://source.bridge.example",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...base64-spki...\n-----END PUBLIC KEY-----\n",
      "activeFrom": "2026-10-13T00:00:00.000Z",
      "activeUntil": "2026-11-13T00:00:00.000Z",
      "revoked": false
    }
  ]
}
```

`publicKeyPem` must be the canonical **Ed25519 SPKI public key** and
must be independently verified before adding it to the operator policy.
Private keys are rejected. This registry is itself trusted only because
it is provisioned by the destination operator, not because of this JSON.

- Reject missing/unknown fields, HTTP or noncanonical source origins,
  non-Ed25519 keys, duplicate origin+fingerprint entries, invalid times,
  corrupt/malformed/oversized policy (>64 KiB), and >32 pinned keys.
- Keys may overlap during explicit rotation. A signed snapshot can use
  either active key while each remains independently pinned.
- Setting `revoked: true` **immediately** rejects ALL proofs by that key,
  including one signed before revocation. No grace-period override.
- Both the signature's issuance time **and the verification clock** must
  lie within the pinned key's configured active interval.
- No trust-on-first-use, no key inference from `attestation.keyFingerprint`
  alone, no automatic revocation reversal or unknown-key fallback.
- The signature verifier still enforces manifest integrity, source identity,
  expiry and strict Ed25519 canonical signature encoding.
- All invalid proofs and keyrings return the same generic
  `PORTABLE_SOURCE_ATTESTATION_INVALID` error without exposing a key.

Successful verification remains **read-only**, with
`importSupported:false`, `writesPerformed:false`,
`mappingApproved:false`, and `snapshotAtomicityVerified:false`.
It does not authorize a destination import, verify a real independent
installation or enforce a one-time replay ledger.

## Unimplemented deployment/security requirements

Signed manifest acceptance still needs out-of-band source ownership proof,
operational key rotation/revocation with audited updates, durable destination
single-use owner approval, independent-instance TLS testing, fresh
destination-state checks, and atomic PostgreSQL apply/rollback.
Track these independently under [issue #205](https://github.com/fatihcayiroglu/Bridge/issues/205).
The existing Android ANR reliability investigation remains [#209](https://github.com/fatihcayiroglu/Bridge/issues/209).
