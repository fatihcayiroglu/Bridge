# P7 C3 — Community structure import preflight (read-only)

**Status:** incremental feature under CI. This preview does not import data,
does not authorize a future import and must not be called a P7 C3/C4 closure.

## API

`POST /api/servers/:sid/portable-import/preview`

Request body has **exactly** two keys:

```json
{
  "targetServerId": "currently-authenticated-target-community-id",
  "document": { "format": "bridge-portable-community-structure", "version": 1 }
}
```

The `document` shown above is abbreviated. Real requests require the full
checksum-valid C2 structure export. The route:

- Requires a current session, **ownership of the destination** and a fresh
  `account-security` step-up grant (`account.import` action).
- Requires the submitted `targetServerId` to **exactly match** the authenticated
  route community ID; reports a 409 on mismatch.
- Checks the strict `v1` schema, unique source IDs, category references,
  roles' permission bits, exact positive-list fields, canonical order,
  unsupported-data declaration and SHA-256 checksum. Rejects invalid files
  with 422 and makes no SQL writes.
- Reads target category/role/channel names and gives a conservative
  Unicode-normalized, case-insensitive comparison with source names. It
  reports name conflicts and duplicate names from the source.
- Returns source/target counts, at most 50 conflict details with a total
  and truncation flag, explicit blockers, `importSupported: false` and
  `writesPerformed: false`. The target structure read must be complete:
  invalid target rows cause a 503 rather than partial/vacuous results.
- Returns `Cache-Control: no-store`. Nonowners receive 403 before any
  source validation or destination child-row reads.

**This is not a uniqueness guarantee.** Same names are not identities; having
no named conflicts does not imply safe import. The endpoint never recommends
an ID mapping, changes permissions, moves members or persists any data.
Checksums detect accidental corruption, not origin or authenticity, and must
not be treated as a signature.

## Still blocked

A safe importer needs a format for category/role/channel permission
overrides, reversible source-to-destination mapping, collision choices,
atomic writes and transaction rollback, concurrency protections, migration
policies for missing fields, and cross-instance evidence on two independently
deployed Bridge servers. Messages, users, secrets and memberships remain
out of scope.
