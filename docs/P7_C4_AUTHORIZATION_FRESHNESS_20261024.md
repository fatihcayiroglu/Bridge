# C4 — credential freshness across PostgreSQL waits

The existing importer already verifies signed source snapshots, an explicit
mapping, destination ownership, grant parity and a durable one-use approval.
This correction keeps its supported existing-row metadata scope and opt-in
switches. It adds no permission, identity or entity migration.

The C4 credential verifier sampled the clock before awaiting its PostgreSQL
evidence. A user-row lock could outlive that sampled time. The approval and
apply services also checked credentials before acquiring destination locks,
without checking freshness again afterward.

Two real PostgreSQL regressions reproduced new approvals from stale proofs:
the credential was 95 seconds old on entry, then a competing transaction held
the owner or destination row for 27 seconds. PostgreSQL reported the writer
actually waiting for a lock. The old code committed an additional approval
after the 120-second credential limit. No fake clock or mocked database was
used in these cases. Six unit negative controls separately reproduced stale
clock samples and missing revalidation after review and before commit.

The C4-specific verifier now samples the existing step-up clock after all of
its awaited SQL evidence, including the same-transaction check. Approval and
apply reuse that verifier after destination review locks and immediately
before COMMIT. All checks use the same SERIALIZABLE client and the existing
locked user row. Failure rolls back the approval or the claim, snapshot
barrier, mapped metadata and audit. Existing ambiguous-COMMIT connection
disposal remains in place. Shared step-up internals and the 120-second policy
are unchanged.

Local focused validation passes 317 portability unit tests and all 18 tests
in the five C4 PostgreSQL suites, with zero skips. This includes both new
lock-wait failures, successful signed approval/apply, replay, concurrent
claims, deterministic rollback and lost-COMMIT-acknowledgement checks. Strict
production/test types and source lint pass without new debt. Full backend,
client, security and exact-head CI remain separate gates.

The existing two-installation TLS lab is reused for final acceptance. These
local PostgreSQL tests do not establish independent deployment, TLS/operator
identity, physical-device certification or unrestricted portability. Issue
#205 and P7 remain open. D2 integration/channel administration belongs to
Claude's #375 workstream and is not modified here.
