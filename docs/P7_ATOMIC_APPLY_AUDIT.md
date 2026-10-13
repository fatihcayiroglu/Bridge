# P7 C4 — atomic redacted apply audit

The successful **existing-mapped-metadata-only** apply from #228 now inserts
a bounded audit record inside the exact same PostgreSQL SERIALIZABLE
transaction as owner authentication, source/target validation, one-use
approval token compare-and-set, categories/roles/channels metadata updates and
permission-grant recheck. The audit INSERT happens **before COMMIT**. A failed
audit write aborts the entire import attempt; no success or half-written
record is permitted.

The standard `audit_logs` row uses an opaque UUID-derived ID,
`serverId` / `actorId` required by the established audit schema,
`portable.mapped_metadata.apply` action, destination server as target and
a fixed JSON detail containing **only** the mode, counts of affected
categories/roles/channels, grant-preservation and no-membership-import flags.
The detail never contains bearer approval tokens, request headers, usernames,
owner IDs, source URLs, source signing keys, manifests, mapping/source IDs,
channel names, permission bits or individual-member data.

**Live PostgreSQL proof** tests that every deterministic claim/category/role/
channel/precommit failpoint produces exactly NO audit row and NO partial
metadata/grant or consumed token. A success records exactly one audit event
with bounded detail. A repeated token cannot apply again or create another
event. Unit tests also exercise failed audit INSERT and failed COMMIT.

This improves the #205 failure/recovery audit requirement, but is not an
independently deployed end-to-end TLS proof, not a user-facing review UI and
not a full membership/message/permission import. No HTTP route or feature
flag changes are made in this PR.
