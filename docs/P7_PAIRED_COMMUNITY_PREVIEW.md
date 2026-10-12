# P7 C3 — Paired community migration preview (read-only)

**No data is imported by this endpoint.** It is a stronger preflight
than the existing structure-only `portable-import/preview`.

## Endpoint

`POST /api/servers/:sid/portable-import/paired-preview`

The JSON body has **exactly** `structure`, `permissions`, and
`targetServerId`. `structure` is the complete v1 community structure
JSON export and `permissions` is the complete v1 channel permission
coverage export. The `targetServerId` must equal the authenticated
route community `:sid` exactly.

The endpoint requires authentication, **destination community ownership**
and a separate, fresh `account.import` / `account-security` step-up grant
before either source document is parsed or the destination child rows
are read. Nonowners get 403, and swapped destinations get 409.

It validates both manifests and their source/channel/role correspondence
via `inspectPortableCommunityManifestPair`, then compares source
category/channel/role names with the **destination topology** and reports
conservative name collisions, counts and truncation markers. It also
includes a `permissionMapping` report from the role/channel remapping preflight:
missing, ambiguous, or type-incompatible role/channel matches are named
without creating a trusted mapping. Even when all diagnostic names match,
`permissionMapping.diagnosticNameMatches.usableForImport` is **false**. Success
returns `mode: read-only`, `writesPerformed: false`,
`importSupported: false`, a nested `permissionPair` report, and blockers
that explicitly identify missing source authenticity, snapshot atomicity,
role/channel permission remapping, SQL transaction rollback, user-specific
grant handling and actual import. A missing or malformed destination row
causes a 503, not an incomplete report.

This is **not** evidence that a future apply would be safe:
- Identical names are not portable resource identities.
- SHA-256 checksums can be recalculated and do not authenticate the source.
- Two downloads can be taken at different times; their simultaneous
  consistency is not proven by matching ID names.
- Permission semantics and capability masks can differ across instances;
  copying grants by ID would be privilege escalation.
- User-specific grants, legacy records, messages and memberships cannot
  be silently transplanted, and are never included in an apply plan.

The API does **not** provide role mappings, authorization to write, a
commit token, an apply endpoint, backups, or atomic migration. It is
only an owner-controlled, no-store visibility step.
