# P7 C4 — double-opt-in existing-row metadata apply (not full migration)

**Feature is OFF by default.** Full portability/issue #205 is NOT complete.

Endpoint `POST /api/servers/:sid/portable-import/mapped-apply` is available
only when an operator enables BOTH:

- `BRIDGE_PORTABLE_OWNER_APPROVAL_ENABLED=true` (owner approval stage)
- `BRIDGE_PORTABLE_MAPPED_APPLY_ENABLED=true` (actual restricted apply)

The destination operator must also configure a pinned, independently trusted
source signing-key registry with its own verifier opt-in. The request MUST
be made by the authenticated destination owner with a new valid
`x-bridge-step-up` (`account.import`) proof, the previously committed
one-time `approvalToken` (secret, never logged), the same signed C2 manifests,
the exact reviewed 7-field mapping, its `confirmedReviewFingerprint`, and
`confirmation: APPLY_MAPPED_PORTABLE_METADATA_ONLY`.

The token is not a free-standing authorization: the writer rechecks the
current owner, current credential state, source signature, operator key
revocation, exact target topology and channel grant parity on ONE SERIALIZABLE
PostgreSQL connection before consuming the one-time token and modifying data.
CAS consumption and ALL updates commit or rollback together; any failed check,
query or commit returns a generic error without a partial success response.
Route defaults to 503 until both operator flags are explicitly enabled.

Only EXISTING, explicitly mapped categories/roles/channels can be updated.
The *only* fields updated are category label/order/collapse, role name/color,
and channel name/topic/category link/order/NSFW/slowmode. NO new role/channel
IDs are created; NO role permission mask, role hierarchy position, channel
grant, membership, user, messages, bot, moderation or credentials migrate.
Unmapped destination rows stay untouched. The operation should NOT be
presented as a full source community replacement or full topology parity.
`importSupported` is not used to imply arbitrary imports.

If a client receives no response because the network fails around COMMIT,
it must not assume rollback OR successful apply; it should fetch a fresh
target fingerprint/re-export before taking any further action. A consumed
token cannot be replayed, and the importer does not retry an ambiguous
COMMIT itself.

## Test and release boundaries

- HTTP tests: anonymous/delegated owner, wrong/missing step-up, independent
  feature flags, forged owner/keyring, wrong mapping/confirmation/token, no
  secret echo, generic failures and 200 response limited to metadata
- Live PostgreSQL tests in prerequisite PR #228: five rollback failpoints,
  genuine write/consume atomicity, stale grants/account/target rejection,
  successful commit and replay denial
- Existing 90% client coverage, migration rollback, Android, self-host,
  federation, security E2E and abuse gates remain mandatory.

**Still UNVERIFIED:** Two independent Bridge deployments with actual TLS
certificates and source export -> signed review -> owner confirmation ->
token issue -> mapped apply -> re-export comparison under an outage,
concurrent edits and restart. Physical mobile-device evidence is separate.
No honest P7 closure claim until the specific issue #205 checklist and
release signoffs are satisfied.
