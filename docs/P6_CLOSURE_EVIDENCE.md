# P6 closure evidence ledger

This file tracks the final P6 closure branch without rewriting the frozen P5 record. A code path is not considered closed merely because it exists: the corresponding regression/integration evidence must pass on the exact PR head, and the final merge must be verified again on `main`.

## Branch under verification

- PR: #119 — `P6 closure: ActivityPub lifecycle, remote DMs, retry evidence`
- Base: `main` after merged P6 W1/W2 (#118)
- Head line: `gpt/p6-closure`
- P7/P8 and music/social-listening work remain out of scope until this ledger is fully closed.

## Implemented on this closure branch

- ActivityPub Note lifecycle: outbound Update/Delete, inbound ordering, durable delete tombstones, and real-PostgreSQL lifecycle coverage.
- Remote ActivityPub direct messages: authenticated recipient read surface, outbound send surface, client panel, focused server/client tests, and ten-locale UI coverage.
- Federation delivery ceiling/outage evidence: shipped default retry ceiling plus accelerated real-process closure harness.
- Migration 079 has a paired rollback migration.

## Closure gates

The final P6 verdict requires all of the following on the same head (or an explicitly documented superseding head):

- Bridge Quality Gate — PASS.
- Bridge Federation + AI Evidence — PASS.
- Bridge Self-host Evidence — PASS.
- P6 Closure Evidence — PASS.
- Mobile Android — PASS.
- Mobile iOS — PASS or a pre-existing documented external/unverified device-only item; no new FAIL.
- Security audit — no high/critical advisory left in the installed dependency graph. The unused `nodemon` dev dependency was removed instead of weakening the audit after GHSA-vfj7-8cjw-p6xm appeared with no patched `braces` release.
- i18n parity/usage — PASS for all ten locales; Remote DM strings are part of the locale tables rather than relying on untranslated fallbacks.
- No product rate limit, permission check, signature rule, SSRF guard, or other security boundary may be relaxed to make a harness pass.

## Final merge rule

Do not mark P6 closed until #119 is non-draft, all required PR-head gates are green, it is merged, and the relevant post-merge `main` gates are checked. Any external ActivityPub/provider/device evidence that cannot be produced must remain explicitly `UNVERIFIED`; it must not be converted to PASS by inference.
