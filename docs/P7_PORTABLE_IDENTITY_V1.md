# P7 C1 — Portable identity JSON v1 (export-only)

**Status:** implemented for exporting a limited profile subset. **Import, community
migration, and P7 C1–C4 closure are NOT complete.** This is separate from the
existing GDPR-style, comprehensive `GET /api/account/export` download.

## API and user flow

From Settings → Privacy, select **Taşınabilir profilimi indir (JSON v1)**.

`GET /api/account/portable-export` requires an authenticated session and the
same fresh `sensitive-export` step-up grant already required for the full
personal-data export. A stolen bearer token alone must not retrieve the file.
The server uses the authenticated account subject; the request cannot select
someone else's user ID. The response is JSON with `Cache-Control: no-store`
and `Content-Disposition: attachment`.

## Exact format (v1)

```json
{
  "format": "bridge-portable-identity",
  "version": 1,
  "exportedAt": "2026-10-11T12:00:00.000Z",
  "identity": {
    "sourceUserId": "source-instance-user-id",
    "username": "alice",
    "displayName": "Alice",
    "bio": "Hello",
    "website": "",
    "pronouns": "",
    "avatarColor": "",
    "bannerColor": ""
  },
  "integrity": {
    "algorithm": "sha256",
    "encoding": "utf8",
    "canonicalization": "ordered-json-v1",
    "digest": "64 lowercase hex characters"
  },
  "portability": {
    "importSupported": false,
    "included": ["..."],
    "excluded": ["..."],
    "limitations": ["..."]
  }
}
```

The example above is illustrative; `digest` is a placeholder, not a real
digest. For the actual checksum, form a JSON object whose properties, in order,
are `format`, `version`, `exportedAt`, `identity`; inside `identity`, write
`sourceUserId`, `username`, `displayName`, `bio`, `website`, `pronouns`,
`avatarColor`, and `bannerColor` in that exact order. Compute SHA-256 over
UTF-8 `JSON.stringify` of that object (no extra whitespace). Implementation:
`server/lib/portableIdentity.ts`.

A plain SHA-256 checksum detects **accidental corruption only**. It is not a
signature or proof of server authenticity and provides no protection against an
attacker who can change both the document and the checksum.

## Deliberate privacy boundaries

Only user-owned, positive-listed profile fields are exported. **Not** included:
email/location, passwords/hashes, TOTP/backup codes, OAuth/refresh/access tokens,
passkeys, private keys, presence, friends, blocks, memberships, messages,
attachments, server-local avatar/banner URLs, or other users' data. Future DB
columns are excluded by default. The original source user ID is **mapping
metadata, not an identifier to reuse as the destination's primary key**.

This is **not** a backup or a complete data subject access response. To download
complete available account data, use the existing personal-data export.

## Read-only import preview (C3 preflight milestone)

Settings → Privacy now accepts a small JSON v1 file and calls
`POST /api/account/portable-import/preview` (authenticated and protected by
the same `sensitive-export` fresh proof). The endpoint **does not save** or
import anything. A valid v1 file returns a field-by-field before/after preview
for the account already signed in. The source `sourceUserId` is only mapping
metadata; the target account ID and username remain unchanged.

The server rejects documents above 16 KiB, unknown/extra fields, incompatible
format versions, invalid timestamps, non-string/oversized profile properties,
unknown integrity algorithms, invalid SHA-256 checksums, and unsupported
capability declarations. Files are only ever parsed as data, not executable
instructions. A checksum is **not** a cryptographic signature: an attacker
can recalculate it after editing the file.

**Destination write-contract compatibility (C3 follow-up):** After verifying
the digest, the preview also rejects checksum-valid but non-applicable profile
values. Display names must already match Bridge's canonical display-name
sanitizer (including its 32-character limit and invisible-character rules);
bio, website and pronouns must be unpadded and at most 180, 120 and 40
characters, respectively. Optional avatar/banner colors must be valid hex
colors. The preview returns 422 rather than showing a value that a future
write would silently trim, truncate, sanitize or refuse. Legacy snapshots
remain exportable; incompatible values must be corrected at the source.
This is **not** an active importer or proof that import writes/rollback work.

A preview is not an importer, and there is no DB mutation or automatic
ownership/community migration. Applying changes, collision policy, safe
rollback, and cross-instance round-trip proof remain explicit C3/C4 gaps.

## Account-profile-only atomic import API (C3 increment; no UI yet)

`POST /api/account/portable-import/apply` is a **separate, explicitly
confirmed** endpoint, not the read-only preview. It requires a signed-in user,
a fresh `account.export` / `sensitive-export` step-up proof, and exactly:

```json
{
  "document": { "format": "bridge-portable-identity", "version": 1 },
  "expected": {
    "displayName": "Current name",
    "bio": "",
    "website": "",
    "pronouns": "",
    "avatarColor": "#2d9cdb",
    "bannerColor": ""
  },
  "confirm": "APPLY_PORTABLE_PROFILE"
}
```

`document` must be the **complete**, checksum-valid v1 export (the abbreviated
example above is not a valid request). `expected` must match the **six current
field values** returned as `fields[].current` by an immediately preceding
authenticated preview. The apply endpoint independently verifies the complete
document and expected-fields shape; the browser cannot bypass validation by
copying a former successful preview response.

One PostgreSQL `UPDATE ... WHERE` compares every expected field in the target
account and updates only `displayName`, `bio`, `website`, `pronouns`,
`avatarColor` and `bannerColor` atomically. A concurrent profile edit, a
deleted target or a stale preview yields **409 without partial writes**. The
source ID, username, credentials, account email, media, permissions, messages
and social/community memberships can never be changed by this endpoint.
Empty optional avatar/banner colors mean **keep the target color**; the preview
shows their effective unchanged values.

A 200 response reports applied fields but is not a community/whole-account
restore. Invalid source content produces 422, missing explicit confirmation
produces 400, and lack of a PostgreSQL write authority produces 503.

**Product limitation:** this first incremental API has no Settings → Privacy
confirmation/apply UI yet. The v1 manifest still declares
`portability.importSupported: false` because full cross-instance/community
migration, credentials and media remain unsupported. The UI remains preview-only
until a dedicated, double-confirmed apply experience is implemented and
independently tested. C4 cross-instance proof has not been claimed.

## Next gates (not claimed complete)

- C1: source/target data format acceptance tests against independently installed
  servers, retention/privacy review, and integrity verification at intake
- C2: permission-checked community topology/roles/settings export
- C3: schema-validated import with dry run, collision mapping, rollback and
  unsupported-field report
- C4: representative cross-instance export/import round-trip

Until the importer exists, the UI and manifest expressly say
`importSupported: false`. No P7 closure is implied by this PR.
