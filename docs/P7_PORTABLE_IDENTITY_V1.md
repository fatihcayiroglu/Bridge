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

## Next gates (not claimed complete)

- C1: source/target data format acceptance tests against independently installed
  servers, retention/privacy review, and integrity verification at intake
- C2: permission-checked community topology/roles/settings export
- C3: schema-validated import with dry run, collision mapping, rollback and
  unsupported-field report
- C4: representative cross-instance export/import round-trip

Until the importer exists, the UI and manifest expressly say
`importSupported: false`. No P7 closure is implied by this PR.
