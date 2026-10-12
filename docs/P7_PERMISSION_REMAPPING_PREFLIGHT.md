# P7 C3 — Cross-manifest permission identity preflight (read-only)

**Status:** pre-apply diagnostics only. This library does not offer a server
endpoint, ID mapping approval, a SQL write transaction or import capability.

`previewCommunityPermissionRemapping(structure, permissionManifest, destination)`
accepts C2 community-structure JSON v1 and the companion permission coverage
manifest. Both inputs are **independently schema-validated** and must describe
the **same source community**. Every source channel must be present in the
permission manifest, and every role override must refer either to a source
role listed in the structure or to the synthetic `__everyone__` marker.
An internally inconsistent pair is rejected rather than partially processed.

The destination parameters are existing channel and role rows with bounded,
validated IDs, names and channel types. Their names are Unicode-NFKC
normalized and case-insensitively compared to source names. For channels,
the channel type must also match. Ambiguous names and unmatched roles or
channels are reported; duplicate target IDs and invalid target rows fail
closed. A name match is **only a diagnostic candidate**, never proof of
shared identity, never an ID mapping, and never permission for writes.

The output reports total canonical role override counts, excluded legacy/
user-specific/unknown-target row counts, aggregate unresolved findings
(with a 50-detail/truncation boundary) and blockers. Even with zero
unresolved findings, `importSupported` remains false and
`diagnosticNameMatches.usableForImport` is false. Nonzero excluded grant
counts add an explicit `UNSUPPORTED_PERMISSION_ROWS` blocker.

**No security proof from a hash:** Source digests establish accidental
corruption detection, not authenticity. An importer would also require
source trust verification, signed mapping approvals, destination owner
consent, no-permission-widening policy, transaction rollback and tests
across two independent Bridge installations.

C3 transactional apply and C4 are still open.
