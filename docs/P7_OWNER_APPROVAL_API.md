# P7 C4 — owner-approved signed mapping token (opt-in endpoint)

**This endpoint is disabled by default. It does not import data.** Issue #205
remains open. It exposes the already merged internal service only when an
operator deliberately sets BOTH:

- `BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED=true` (this new route)
- `BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED=true` and valid
  `BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64` (operator-pinned keys)

## Endpoint

`POST /api/servers/:sid/portable-import/owner-approval`

Authenticated destination OWNER only, rate-limited, `x-bridge-step-up`
credential proof for `account.import`, plus full exactly-shaped JSON:

- `targetServerId` must equal `:sid`
- `structure`, `permissions`, `attestation`: paired signed C2 source data
- `expectedSourceOrigin`: canonical HTTPS origin selected by owner
- `expectedSourceServerId`: exact source server identity
- `mapping`: the **seven** signed-review choices/constraints:
  `targetServerId`, `structureDigest`, `permissionsDigest`,
  `expectedTargetDigest`, `categories`, `roles`, `channels`
- `confirmedReviewFingerprint`: 64-lowercase-hex fingerprint of the
  owner-reviewed signed mapping, including its exact roles/channels and
  permission consequences
- `confirmation`: exact literal
  `CONFIRM_SIGNED_MAPPING_AND_PERMISSION_CONSEQUENCES`

Unknown extra fields, client-provided keyrings, owner identity or arbitrary
DB connection hints are rejected. Request size, mapping lengths, target
identity, data shapes and hex digest formats are bounded before calling
the importer-free service.

The server independently pins a revocable source keyring from environment
configuration. The internal service uses a single SERIALIZABLE PostgreSQL
transaction to recheck the current OWNER, signed source, fresh account
credential factor/version, target topology and exact channel grants and then
store a hashed approval secret. **Only after COMMIT** is a 120-second,
one-use approval token returned. Responses are `Cache-Control: no-store`
and never include the source keyring. Repeated or malformed requests are
rate-limited and denied with generic errors.

**Not implemented:** There is no apply endpoint. Neither a staged token nor
the owner's API confirmation phrase permits category/role/channel writes.
An interactive owner UI presenting all mapping choices and consequences,
an importer atomically consuming the token with full revalidation, rollback
failpoints, and two-independent-TLS-deployment evidence are still required.
The API assertion does not prove the user inspected a UI; a future client
must present that review explicitly. The night/full media suite may only
be claimed if actually run; ordinary PR builds do not imply it.

Do not turn on this endpoint for a general release before the importer and
human review UX have independently passed their own acceptance criteria.
