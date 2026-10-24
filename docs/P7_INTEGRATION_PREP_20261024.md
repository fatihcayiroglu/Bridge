# P7 integration preparation — review only

This branch assembles the latest requested fixes on candidate #375 without
modifying that candidate or production main. It is not deployment authorization,
release acceptance, or permission to merge #375 indirectly through another PR.

## Pinned sources and order

| PR | Pinned commit | Dependency / purpose |
| --- | --- | --- |
| #375 | `1bde050f848a9d676c84b7cf1b4b4ea4cf54ce4b` | Existing D2 candidate and #386; integration base |
| #400 | `f398a57459ee2dca7612322b151b6757b638a97d` | Channel step-up plus corrected real-PG proofs; base #375 |
| #406 | `bee93197faebb0fc585468d04ed1a521e03f9ef6` | Final thread/reply admission; base #400 |
| #402 | `5590208684fb94c0e7759e5c91b7251fa594ac10` | Routine login INFO minimization; base #375 |
| #382 | `884b8fd7493f8a5c2440933f70c15649d943e024` | Measured unsupported release upgrade; includes #374 security dependencies |
| #398 | `7bff83bf9c84e49c6b3688f3b9a128a14757efb7` | Read-only upgrade-source preflight; base #382 |
| #404 | `ed4e473adcad0ae4da0f7554f33fcbdd62dea831` | Reject nonempty sources lacking base tables; base #398 |

The merge commits preserve source history and required-review boundaries. No
outdated intermediate D2 head was merged. #382 does not itself contain #375.
093 remains reserved for #379 reporting and 094 for #381 erasure indexes; 095
requires 092's function and no columns from those reserved migrations.

## Local combined evidence

- Fresh boot passed in a dedicated PostgreSQL 18 database.
- Full PostgreSQL/Redis/S3-compatible suite: **426 tests / 62 suites pass,
  zero skipped**. RustFS supplied actual S3-compatible storage; this does not
  claim local pgvector, proprietary MinIO, production throughput or physical devices.
- Focused combined server/CLI/security tests: **195 pass / 8 suites**, zero skipped.
- Strict test types and production indexed-access/catch gates pass with zero debt.
- The real PostgreSQL complete rollback gate passes, including its isolated
  disposable-database replayer: 73 lossless, 16 expected dependencies, one expected
  irreversible and three shared-object classifications; zero actual failures.
  Full ordered down/up has zero missing or extra schema objects.

Source #406 additionally has identical fresh/upgraded complete public-schema
dumps and content-preserving trigger down/up/replay tests. These synthetic
measurements do not certify migration from an existing v1.122.0 installation.

## Acceptance gates still open

- Exact integration-head full Quality Gate and relevant platform/deployment CI.
- First-failure Android investigation: #404 run
  [40090767471](https://github.com/fatihcayiroglu/Bridge/actions/runs/40090767471)
  failed L01 hot resume and ANR01, with 33 passes, two failures, zero skipped and
  six measurement-only checks. The artifact records an input-dispatch ANR and
  WebView/binder main-thread classification. Root cause remains unestablished;
  no retry or Android source change was made. A later green run does not resolve it.
- Human code-owner review and actual branch-protection requirements. Both REST
  and GraphQL protection queries were denied by the GitHub integration. No
  absence of protection may be inferred from that denial.
- Separate owner authorization before #375, or any branch containing it, can
  merge into production main; then exact post-merge main CI.
- Operational access controls and retention for exceptional security telemetry:
  #402 removes routine INFO identifiers but does not establish those controls.
- Remaining D2/P7 acceptance, including representative storage performance,
  cross-platform residuals, staged data-preserving legacy upgrades and the other
  open milestones. Keep #321 open. No complete P7 or production E2EE claim.

CI-only comparisons #399, #401 and #403 must never merge. #405 also targets main
with #400's exact head and therefore contains #375; it was marked draft and
explicitly labelled DO NOT MERGE. The implementation remains in #400.
