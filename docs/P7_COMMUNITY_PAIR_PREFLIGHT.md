# P7 C3 — Cross-manifest source consistency preflight

**Status: read-only helper and regression tests.** Not an importer.

C2 exports two separate artifacts:

1. Community structure: topology, role definitions and channel metadata.
2. Permission coverage: allow/deny matrices by channel and role, plus
   counts for legacy/user-specific/unknown-target rows not included.

Checking the SHA-256 digest of each file **independently is insufficient**
to establish that they belong to the same source or that every channel and
role permission target exists. Even a maliciously modified document with a
freshly recalculated digest must not authorize an import.

`inspectPortableCommunityManifestPair(structure, permissions)`:
- Parses and validates each artifact under its own strict v1 schema.
- Refuses a mismatched `sourceServerId`.
- Requires **exactly one** permission matrix for each exported channel.
- Refuses permission references to channel or role IDs absent from the
  source topology; recognizes `__everyone__` only as the special source
  role marker.
- Reports total role/everyone overrides and excluded legacy, individual
  and unknown-target records, without exposing user identifiers.
- Returns `mode: read-only`, `importSupported: false`,
  `writesPerformed: false` and explicit blockers.
- Returns both snapshot timestamps/digests, but **does not claim**
  they were read from a transactionally consistent source moment.

**Still blocked:** independent source authenticity, transactional source
snapshot, destination ID remapping, exact permission-grant correspondence,
non-escalation policy, explicit owner approval, atomic destination changes
with full rollback, and two independent deployment round-trip tests.
This helper performs no network or database writes and does not open an
apply endpoint.
