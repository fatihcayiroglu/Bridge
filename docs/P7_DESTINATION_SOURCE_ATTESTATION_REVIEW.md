# P7 C4 — destination owner's signed source review (read-only)

The endpoint `POST /api/servers/:sid/portable-import/source-attestation-review`
allows a destination community owner to validate a downloaded signed source
structure+permissions pair against **only the independently provisioned
destination operator's public-key registry**.

**Not an import approval or apply operation.** It does not create a consent
token, persist a review, bind live destination topology, or write any data.
The response always retains `mappingApproved:false`, `importSupported:false`,
`writesPerformed:false` and `targetTopologyBound:false`.

## Deployment opt-in

By default the route's crypto-verification path is disabled, even for owners.
Provision both values outside HTTP, in the deployment secret/config manager:

- `BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED=true`
- `BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64=<canonical base64 of the pinned registry JSON>`

The registry uses the exact versioned schema, independently verified
Ed25519 public keys, revocation and rotation rules in
[`P7_SOURCE_KEYRING_ROTATION_REVOCATION.md`](P7_SOURCE_KEYRING_ROTATION_REVOCATION.md).
Never derive the registry from the untrusted export, `Host`, user payload,
remote JWKS, DNS, or a source URL. Without valid configuration, respond
HTTP 503, not a trust-on-first-use fallback.

## API

Authenticated, rate-limited request with fresh `account.import`
(`account-security`) step-up proof by the **CURRENT destination owner**.
Body fields are exactly:

```json
{
  "structure": { "..." : "v1 signed structure manifest" },
  "permissions": { "..." : "v1 signed permission manifest" },
  "attestation": { "..." : "v1 source attestation" },
  "expectedSourceOrigin": "https://explicit-owner-selected-source.example",
  "expectedSourceServerId": "explicit-owner-selected-source-community-id"
}
```

The owner must explicitly select the expected source origin and community
ID; these must match the signed source proof. This request choice does NOT
provision, rotate or override any trust key. A valid signature is accepted only
when the corresponding Ed25519 key **already exists in the independent
destination operator-pinned registry**, is not revoked, is within its
activation/retirement period, and the attestation and manifest digest checks
all pass.

Return codes: 401 unauthenticated; 404 unknown destination; 403 non-owner or
missing/incorrect import step-up; 400 malformed request; 503 disabled/missing
operator registry; 422 invalid signature, source identity, key policy,
revocation or pair integrity; 200 verified read-only proof diagnostics.

All responses set `Cache-Control: no-store` and
`X-Content-Type-Options: nosniff`. No private key or source registry is sent,
and invalid crypto proofs return the same generic error. The API never
uses a user-submitted `publicKeyPem` or approval flag.

## Remaining release blockers

The endpoint is intentionally NOT an authorization to apply source data. It
does not verify the current destination topology, guarantee remotely provable
snapshot atomicity, protect source replay, or create a durable single-use
owner approval. Those features require a separately designed, transactionally
safe PostgreSQL consent ledger with fresh owner permission checks, mapping
fingerprints, source identity/digests and expiry bound to one commit.

Atomic destination apply/rollback and two physically independent deployments'
full export→approval→import→re-export tests are also not done. Track these in
[P7 #205](https://github.com/fatihcayiroglu/Bridge/issues/205).
