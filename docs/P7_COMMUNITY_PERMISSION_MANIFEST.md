# P7 C2 — Source community permission coverage (read-only)

**Incremental permission export. NOT community import, NOT C2 or C4 closure.**

The topology v1 snapshot intentionally excludes channel permission rows. A
future importer that simply recreates channels and roles would **silently
lose private-channel denies and grants**. This adjacent endpoint makes
canonical role permission rows visible under an owner-only permission
manifest and reports excluded legacy/user rows by count.

## Endpoint

`GET /api/servers/:sid/portable-permissions-export`

- Authenticated **source owner only** and a separate fresh
  `sensitive-export` step-up proof. No delegated manager access.
- `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`,
  fixed attachment filename. 404 for a missing community; 403 for a
  nonowner/missing proof.
- Read all channels and roles from the source, then both canonical
  `channel_permissions` and legacy `channel_overrides` per channel.
  Reads run in batches of eight to bound database concurrency.
- Any missing read, unknown role reference, invalid permission mask,
  duplicate role override or foreign/incomplete row fails the entire
  response with 503 — **never a partial success**. Up to 500 source
  channels are supported in this v1 increment; larger source topologies
  return 413 without truncation. The result is also bounded to 512 KiB.
- Data is a deterministic allowlisted JSON document with
  `format: bridge-portable-community-permissions`, `version: 1`,
  `sourceServerId`, stable sorted `channels[]` and `integrity`
  SHA-256 over format/version/export timestamp/server ID/channel matrix/
  unsupported counts in that exact insertion order. SHA-256 is **not**
  proof of origin; it only detects accidental corruption.

The only transferable-looking row shape is
`{ roleSourceId, allow, deny }` under each channel source ID. Persisted
source role IDs are **mapping metadata**, never destination DB IDs.
The server's own ID and `__everyone__` both map to the canonical
`__everyone__` source role marker. Both allow and deny are validated
through the same permission pair parser used for channel writes.

**Privacy and completeness:** legacy rows and canonical per-user or unknown
target rows are never serialized wholesale. Instead,
`unsupported.legacyOverrideRows`,
`unsupported.individualOverrideRows`, and
`unsupported.unknownTargetRows` report their actual counts. The
download contains no member identity, user-target ID, message,
credentials, webhook secret, or audit record. The response always
declares `portability.importSupported: false` and
`portability.migrationReady: false`, even when unsupported counts are
zero: category/channel/role remapping and rollback do not exist yet.

## Remaining work

Before a real apply: verify source authenticity independently of a
checksum; define a non-privilege-escalating override mapping policy,
require destination owner approval, implement atomic transaction
rollback with conflict/concurrency gates, and test two independently
installed Bridge server instances with role/channel permission parity.
User-specific grants require explicit product-level handling and
must never be silently dropped.
