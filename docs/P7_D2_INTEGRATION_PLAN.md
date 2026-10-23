# P7 D2 — integration plan for #345, #353, #354 and #356–#362

## Recommendation: merge #362 alone, once, as a merge commit

Every earlier head in the stack still carries a defect that #362 fixes:

| PR | Head defect that #362 fixes |
|---|---|
| #356 | soft-delete + content rewrite bypass of the write barrier; rows movable out of an expired channel; migration number 085 collides with #345 |
| #357 | the claim deletes the channel row, so FK cascades run unbounded inside the claim; double-claim race; open reports cascade away with the channel |
| #358 | an expired channel counts as the server's "permanent" channel |
| #360 | no live list sync (`channels:changed`), so already-open lists never learn of new channels (Android D2L01) |
| #361 | — (its fixes are included unchanged) |
| #345 | its report → channel FK still cascades (migration 088 changes this) |

Merging any of #356–#361 on its own would put that defect on `main`, and the
migration IDs would not match the final chain (085–090).

`claude/ecstatic-einstein-d9am2j` (#362) contains `main`, #345, #356–#361 and
the fixes. The integration branch also merges #353, #354 and #359 into it:

- `pins.ts`: #353 and #359 both guard pins and files. The integration keeps
  one guard, #359's `channelRecordIsLive`, which runs before authorization, so
  an expired channel is a 404 for everyone. #353's PG test still passes
  against it.
- #354's thread tenant fixtures seed a legacy mismatched row with the barrier
  trigger disabled inside one transaction. The barrier now refuses that write,
  and it also checks the OLD row, so the reset uses the same path. Assertions
  are unchanged.

## Steps

1. Retarget #362's base to `main`. Its diff is then exactly what lands.
2. Exact-head CI on the final head must be green before merging:
   - Quality Gate (unit, real PG/Redis/MinIO, rollback gate, migration chain);
   - Mobile Android emulator journeys, including D2L01;
   - Mobile iOS.
3. A human reviewer approves (branch protection), then merges #362 with a
   **merge commit**, not a squash, so the reviewed PR commits stay
   addressable.
4. Post-merge `main` CI (push-triggered Quality Gate and Android) must be
   green.
5. PR housekeeping (owner):
   - #345, #353, #354 and #356 have `main` as base. GitHub marks them merged
     once their head commits are in `main`.
   - #357, #358, #360 and #361 are stacked on feature branches. Close them as
     "included in #362".
   - #359's base was #355's branch (already merged). Retarget it to `main` or
     close it as included.
   - #326, #331, #348, #349 and #351 are older dormant drafts superseded in
     scope. Close them as superseded.

## Acceptance that remains after this merge

- Owner-approved policy is implemented: report retention, 90-day scrub.
  Other open policy items are listed in `P7_FINAL_CLOSURE_LEDGER_20261016.md`.
- The expiry configuration UI and disclosure that report snapshots outlive the
  channel are included in #362 (`c3002bc0`), with all ten locales. Preserve
  those controls and their tests; they are no longer an unimplemented item.
- iOS simulator equivalent of D2L01, and production-scale S3 throughput.

## Review follow-up (2026-10-23)

The independent `p7/d2-acceptance-20261023` branch contains a correction to the
089 object-release lease protocol. Previously a worker whose lease had been
reclaimed could overwrite the newer attempt's state, error and retry deadline.
Real PostgreSQL interleavings reproduced late success, retained and failure
completions; all three altered the successor before the correction. Every
completion/retry now checks the attempt number and unexpired database deadline,
and each object renews its own lease before storage work. Superseded work is
reported separately and cannot count as a successful release.

Review and integrate this correction before accepting the worker's recovery
contract. It does not change migration numbering, object reference policy or
the outstanding iOS/S3 acceptance. Security PR #363 independently patches the
dependency advisories reported on `main`; #362's older green runs do not prove
that its dependencies pass the current advisory database.
