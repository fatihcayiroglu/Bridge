# P7 C2 — Owner-only community structure export (partial foundation)

**Status: draft milestone.** The export route is read-only and restricted to
the **authenticated source community owner**. It requires a separate recent
`sensitive-export` step-up proof. It is **not** a migration, backup, import or
proof of cross-instance portability. P7 C2 and C4 are still open.

## API

`GET /api/servers/:sid/portable-export`

- 401 for unauthenticated requests, 404 for missing communities, 403 for
  nonowners and missing/wrong fresh proof.
- 200 JSON with `Cache-Control: no-store`, a safe fixed attachment filename
  and `X-Content-Type-Options: nosniff`.
- 409 `PORTABLE_COMMUNITY_SOURCE_INCONSISTENT` if the source structure cannot
  be represented without silently dropping a reference/invalid permission.
- 413 when the complete serialized document would exceed 512 KiB.

The response uses `format: bridge-portable-community-structure`,
`version: 1` and contains source-to-target **mapping identifiers** (never
IDs that can be written as-is into a destination installation). Its
`portability.importSupported` flag is **false**.

Exported fields are explicit: community name, description and icon;
category name/order/collapsed state; channel name/type/topic/order and
category reference, legacy category label, NSFW and slowmode; role
name/color/position/permission mask. Lists are stable-sorted by order
and source ID. No DB row is serialized wholesale.

**Excluded:** members, user IDs and member-role assignments, messages,
attachments, channel permission overrides (including legacy/user-specific
overrides), invites, webhooks, credentials, bots, moderation records and
secrets. This exclusion is intentional: the v1 structure snapshot is not a
faithful representation of all community authorization behavior.

`integrity.digest` is SHA-256 of the UTF-8 JSON serialization of the
ordered top-level object (format, version, exportedAt, community, categories,
roles, channels). It detects accidental corruption, **not authenticity**;
anyone with the file can replace its contents and recompute the digest.
Do not accept an imported snapshot based on this hash alone.

## Security/acceptance boundaries

The owner gate is checked before accessing child category, role or channel
rows. Even a member with delegated `MANAGE_SERVER` permissions cannot
export hidden topology. A stolen access token cannot bypass step-up.
Invalid or foreign category references, unsupported channel types and
invalid role permission masks fail closed; no partial export is returned.
The Jest regression suite checks the positive list, identity/scope
enforcement, full refusal, and digest reproducibility.

## Work still required for C2/C3/C4

C2 must cover a validated permission-override representation, retention
and privacy review, and a verified migration schema for roles/channels.
C3 needs a dry run, collision and remapping model, transaction rollback,
and source-to-target migration safety gates. C4 needs **two independently
deployed installations**, a representative export→dry-run→apply→re-export
comparison, and evidence that unsupported data is reported rather than
silently lost. No user membership or identity migration is included.
