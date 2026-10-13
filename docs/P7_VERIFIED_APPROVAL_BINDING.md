# P7 C4 — signed locked review to exact one-use approval binding

**Unmounted bridge only. No token, HTTP approval, consent or import is enabled.**

Merged #222 can verify, using one caller-owned SERIALIZABLE PostgreSQL client,
the pinned and revocable source Ed25519 attestation, explicit category/role/
channel mapping, current destination owner/topology and exact channel grants.
Merged #223 now requires the grant digest in the durable one-use approval
record. The two must not be connected by copying untrusted hashes out of a
request or from two different PostgreSQL snapshots.

The new `deriveVerifiedPortableApprovalBinding` is a narrow, non-authorizing
adapter. It accepts that SAME caller-owned transaction client and calls the
locked signed review directly. Only AFTER it succeeds does it construct
`PortableApprovalBinding` from the freshly verified review, the validated
signed source tuple and the owner ID used in the actual SQL row lock.
It includes `targetGrantDigest`, `targetTopologyDigest` and the exact source
manifest/signer/snapshot binding. It refuses malformed, mismatched or missing
components with a generic error.

The output explicitly says `consentVerified:false`, `tokenIssued:false`,
`writesPerformed:false` and `importSupported:false`. No database access is
made outside the supplied client. The signer registry must be supplied from
trusted server-side deployment configuration — NEVER the HTTP request.

**Still necessary to issue a usable approval:**
- Current authenticated OWNER plus fresh `account.import` step-up on an
  actual consent action, with full exact choices presented to the owner
- Derivation and one-use token insertion inside one SERIALIZABLE transaction;
  calling the existing independent-pool staging helper from a detached
  review would reopen the race and is therefore NOT sufficient
- Re-checking source revocation, identity/owner/topology and every permission
  on the SAME apply-client transaction before claiming; category/role/channel
  writes must be atomic with token consumption
- Real failure/recovery, two independent TLS installations and physical-device
  acceptance evidence

This PR does not claim issue #205 or P7 is complete.
