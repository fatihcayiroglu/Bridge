Title: Enforce history permission and current-content checks on semantic responses

Restricted members could retrieve channel history through semantic search/digest despite lacking READ_HISTORY. Warm digest caches also retained revoked or deleted content, and cached AI explanations could quote inaccessible messages after match revalidation.

Require both channel visibility and history permission on all semantic-derived paths, bind digest caches to a current authorized snapshot, use that same snapshot for excerpts/aggregates/AI input, and remove retained provider prose from cached search delivery.

Focused source commit: `161aa969e4354c512e4dd4ec4ff18046b1a914fa`, based on main `c517364b9289d13e16101a30d080ca51125971a5`. Five files; does not include privacy, HTTP-signature assertion or corpus registration commits. A separate branch can cherry-pick this commit from main for review.

Validation on the composed audit checkout, with exact source hashes recorded in the evidence ledger:
- Main plus new regression suite: 7 fail / 1 pass; corrected code: 8 pass.
- Semantic existing + new targeted suites: 113 pass.
- Real PostgreSQL/Redis + JWT + CSRF proof: 3 pass, including an actual warm-cache hit before revocation.
- Removing READ_HISTORY: 3 failures; removing digest snapshot binding: 2 failures; retaining cached explanation: 1 failure.
- Full composed server suite: 12,011 pass, 0 skips; typechecks, lint and server build pass.

Known limits: no real external AI/pgvector or multi-node race proof. Authoritative reads repeat on cache hits and have scan cost. Cache delivery is blocked after revocation/deletion; cached bytes still expire by TTL. See the independent audit report for remaining artifact lifecycle risks.

Remote CI is unverified because GitHub API access is blocked. This file is a prepared description, not an opened PR. Recheck latest main, active work and exact-head checks before publishing a Draft PR; never merge without owner authorization.
