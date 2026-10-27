# Bridge native pilot continuation — 27 October 2026

P7 remains OPEN. This is an isolated local continuation of PR #517 at
`1969a2a148aafdce4a1320ef66ddd7aa036b3f7c`, on
`codex/bridge-native-outbox-recovery-20261027`. No merge, deployment or production
configuration change was performed. Capacitor and Abuse Lab B1 are untouched.

## Recovery

No original Claude worktree was located in the searched local user/workspace
locations. A fresh clone preserves all advertised remote branches. No existing
checkout was reset or discarded. Local-only changes on another machine remain
unrecoverable from GitHub; this clone does not prove they never existed.

The latest #517 head already contains `check-expo-cli-zod.cjs`, both backend
integration files, and the realtime adapter/test. `host-cpu.mjs` and its test
are committed separately on `claude/209-cpu-contention-evidence` (`bcaaf532`).
Neither outbox file was found in remote history; the two new files here are a
new implementation, not a claim to have recovered Claude's uncommitted bytes.
The original 11-case native mutation script was not found in tracked history.

## Implemented

- Fixed a demonstrated account-boundary defect: a send waiting behind another
  send could execute under the next account. Admission now captures the session
  epoch and socket lifecycle and validates both before emission. The regression
  failed before the fix; `bridge-first-failure.log` retains that evidence.
- Added optional `ackId` sends and correlated `message:ack` confirmation. An echo,
  wrong-channel ACK, duplicate old ACK or unrelated refusal cannot confirm/fail
  another keyed send. Existing legacy unkeyed callers retain their contract.
- Added a bounded memory-only outbox, typed interface, serialized flush, explicit
  stable-id retry and session-bound clearing. Uncertain/rejected operations stop
  younger sends. Late results cannot populate another account. Snapshots are
  immutable. Unresolved entries cannot be silently discarded.
- Added a fail-closed Node mutation result parser counting failed AND cancelled
  tests. Missing/inconsistent summaries, skips/TODOs, syntax/import errors and
  timeouts are not successful survivors. A real timeout-cancelled test validates
  the parser. The tracked replacement campaign mutates temporary copies only.

The server already has durable `(userId, ackId)` uniqueness and replay lookup in
`server/db/postgres/schema.ts` and `server/socket/handlers/messages-send.ts`.
That implementation was inspected, not freshly qualified against PostgreSQL in
this cycle. The outbox lost-ACK test uses a simulated deduplicating server;
it does not prove database durability or exactly-once delivery.

## Fresh verification

Commands run from repository root, using Node **24.22.1** and a workspace-local
npm **11.6.2** (no global install). CI pins Node 22.19.0; that runtime difference
remains an exact-head CI requirement.

| Check | Result |
|---|---|
| `node --test mobile-native-pilot/tests/*.test.mjs` before edits | 71 PASS, 0 FAIL/cancelled/SKIP/TODO |
| Same command on final implementation | **81 PASS, 0 FAIL/cancelled/SKIP/TODO** |
| `npm ci --no-fund` in pilot | PASS, 486 packages installed |
| `npm audit --audit-level=low --prefix mobile-native-pilot` | PASS, 0 vulnerabilities |
| `node .../typescript/bin/tsc --noEmit -p mobile-native-pilot/tsconfig.json` | PASS, exit 0 |
| `node mobile-native-pilot/scripts/check-expo-cli-zod.cjs` | 16/16 controls PASS |
| `node mobile-native-pilot/scripts/check-session-mutations.mjs <new-output>` | Baseline 23/23; 2 DETECTED, 1 SURVIVED; **exit 1** |
| Real-backend integration command | **FAIL at missing BRIDGE_IT_ORIGIN**, not a backend pass |
| `git diff --check` | PASS |

The mutation survivor removes eager access-token clearing at transitions; the
phase-gated public getter still prevents observing it. Epoch-fence and
single-flight mutants fail 3 and 1 tests respectively. This is a three-case
reassessment, not reproduction of the unavailable prior 11-case campaign.
No assertions were weakened. Initial classifier fixture failures and the
repaired run are retained under `evidence/2026-10-27/`.

## GitHub snapshot

All six requested PRs are OPEN/unmerged. Exact SHAs and read-only workflow
results are preserved in `CONTINUATION-2026-10-27.json`.

- #516 `acb5b9be`: native checks green; root Quality Gate red.
- #517 `1969a2a1`: native checks run 40564418863 green, including the audit,
  typecheck and Android/iOS JS exports. These results precede our local edits.
- #518 `e7de5d5c`: backend PKCE work is separate; inspected run snapshot includes
  running gates. No claim of overall green.
- #519 `15602ca7`: stacked security fix; PR-triggered lookup returned no runs.
  The connector filters out workflow_dispatch, so this does not prove no CI ran.
- #513 `ffae5f76`: Android run 40534247361 FAILED. It is not a confirmed #209 fix.
- #506 `e75ddaab`: PR-triggered lookup returned no runs; dispatch-only results
  must be checked separately before acceptance.

#209 and #416 are open. No controlled emulator/physical-device comparison or
Wayland reproduction was performed on this Windows host. Existing failure
evidence was left intact. New code has not been pushed, so no exact-head CI
exists for this continuation and no blocked Quality Gate was rerun here.

## Remaining gates and next implementation

The app screens still use fixtures; the new outbox remains a dormant capability.
It must be wired through a reviewed account-scoped messaging controller before
claiming a working React Native messaging application. Reconnect flush must be
explicitly triggered; unknown outcomes require an explicit stable-id retry.

Still required: live PostgreSQL 16 + Redis integration with #518, lost-ACK replay
and history reconciliation against the real server, encrypted durable local
persistence and restart recovery, device Keychain/Keystore/browser tests,
account-deletion journey, Android/iOS release builds and physical performance
measurements. No backend test origin/redirect is configured here; no PostgreSQL,
Redis or Docker process/tool was found by the bounded availability checks.

Next: add a real-backend outbox lost-ACK test using the original ackId, assert one
persisted row after reconnect and reconcile history by server message ID. Run it
against an isolated #518 server with PostgreSQL 16/Redis before wiring the UI.
