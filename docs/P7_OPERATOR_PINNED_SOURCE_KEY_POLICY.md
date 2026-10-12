# P7 C4 — pinned source-key rotation and emergency revocation POLICY

**Status:** Unmounted, offline destination trust evaluator. **No operator
configuration persistence, admin UI, mutable trust registry, network key
discovery, import approval or destination database writer.**

`verifyPortableSourceAgainstPinnedPolicy` validates a source attestation
against a policy that the destination operator has already installed via a
**separately authenticated, out-of-band process**. Never pass the policy from
the export artifact or client request. Policies are scoped to an exact
`https://` source origin **and** one source community identifier.

Each policy lists up to sixteen unique Ed25519 public keys as canonical
SPKI PEM with explicit SHA-256 fingerprint, `activatedAt`, optional
`retiresAt` and a mandatory `revoked` boolean. No private key appears
in the policy or verifier output.

## Rotation and revocation semantics

1. An operator independently verifies a successor source key; the key is
   **not** discovered by contacting the untrusted origin.
2. Add the new public key to the operator-managed trust policy with a future
   or current activation time. For a planned rotation, temporarily keep the
   previous key active for a finite overlap window.
3. Proofs are accepted only if their signer key was already active at the
   signed `issuedAt` **and** still active at verification time. Proofs for
   revoked/retired keys are denied immediately, even if the signed contents
   predate revocation. The original five-minute attestation expiry still
   applies.
4. After the prior key retires, remove it from the active policy. Lost or
   compromised keys must be explicitly `revoked: true`; the cryptographic
   signature alone is **never** sufficient to override revocation.
5. If a pin is malformed, extra policy metadata appears, two pins share a
   fingerprint, or the origin/community differs, the entire verification
   fails closed with one generic `PORTABLE_SOURCE_TRUST_UNAVAILABLE` error.

This policy is not learned from an upload, user-supplied key, HTTP `Host`,
DNS, a source JWKS document or any implicit trust-on-first-use mechanism.
Signed manifests still undergo the pre-existing paired schema/digest and
Ed25519 verification.

The helper deliberately returns `importSupported: false`,
`writesPerformed: false`, `mappingApproved: false`, and
`replayPreventionImplemented: false`. A valid signature and current
operator pin do **not** authorize data migration or establish a durable
one-use approval.

## Further engineering work — #205

A source-key trust registry must eventually be stored with restricted
admin authority, an audit trail, atomic policy revisions and version
checks against concurrent approval, encrypted or access-controlled
administrative provisioning, rollback and key-compromise recovery. Tests
must prove a revoked pin cannot be re-enabled by an old stored policy.

This offline evaluator is only one pure policy component, **not** that
durable registry. Do not expose it on an import endpoint until the durable
trust store, destination owner consent and PostgreSQL serializable apply
contract in [#205](https://github.com/fatihcayiroglu/Bridge/issues/205)
are actually implemented. Nothing here demonstrates two independent
production deployments or five physical device platforms.
