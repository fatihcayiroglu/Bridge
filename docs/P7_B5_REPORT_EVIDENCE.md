# P7 B5 — evidence-safe message reports (#336)

## Problem (reproduced on `main`, tests in this PR)
A report stored only `messageId`. The moderator queue rendered the message's current text, so the reported author could edit
(history keeps 10 versions) or delete (content overwritten with `[Mesaj silindi]`) the message and change what moderators review.

## What this PR implements (disabled by default)
- Migration `085_message_report_evidence`: nine nullable `evidence*` columns on `message_reports` and a bounds CHECK
  (text ≤ 4000, names ≤ 200). No default, no backfill, no new foreign key. Rollback `085…down.sql` fails closed if any snapshot exists.
- `REPORT_EVIDENCE_SNAPSHOT=1` makes `POST /api/messages/:id/report` store a snapshot at report time: visible text (≤ 4000
  code points, truncation flagged), author id and display name, message `createdAt`/`editedAt`, capture time, and the attachment
  **name and type only** (never a URL or file body). With the flag unset nothing is stored and behaviour is unchanged.
- `GET /api/servers/:id/reports` (still `MANAGE_MESSAGES` only): a report with a snapshot returns `evidence` and shows the
  reported text as the preview, with `state` = `unchanged` | `edited` | `deleted` (current message compared with the snapshot).
- Moderation tab shows "edited / deleted since it was reported" (10 locales).

## Not decided here (owner decisions)
| Decision | Recommended safe option | Smallest decision needed |
|---|---|---|
| Retention after resolve/dismiss | Scrub `evidence*` 30 days after `resolvedAt` by a leased job; keep metadata row | Number of days, or "never scrub" |
| Author account erasure vs an **open** report | Keep the snapshot until the report is resolved, then scrub; document in the privacy notice | Does an open report outrank erasure? |
| Legal hold | Out of scope until a counsel-approved rule exists | Whether any hold exists |
| Hard delete of the message or user | Unchanged: `message_reports` still cascades from `messages`/`users`, so a hard delete removes the report | Whether hard delete must preserve open reports |
| Enabling the flag in production | Enable only after the retention and erasure rows above are decided | Yes/no |

Ordinary message deletion, account erasure, moderation evidence and legal retention stay distinct: this PR changes none of the
first two and adds only the third behind a flag.

## Evidence
Local (not CI): server jest `report-evidence` 11 tests, real PostgreSQL 16 `message-report-evidence.pgtest` 5 tests, migration rollback gate
`verify-migration-rollback.js --ordered` green on a disposable PG16, client `moderation-tab` 39 tests. See the PR for the exact-head CI.
