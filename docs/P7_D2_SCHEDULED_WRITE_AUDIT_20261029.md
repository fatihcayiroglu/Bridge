# P7 D2 scheduled-write boundary — 2026-10-29

P7 and #321 remain OPEN. This change is stacked on #576
(`104b60447b7ac69392994f5cc04c0c3153408538`), which already includes #574
(`9f9705ed4b01cbf8670ba469cb9bd5d57f6dead2`). Neither branch is merged to main.

## Implemented boundary

Authenticated schedule creation checks the existing canonical
`channelWriteAvailability` after membership, timeout and permission checks.
Gone channels return 404; unverifiable authority returns 503 without queuing.
The worker checks the same authority before dispatch, after asynchronous content
verification and before finalization/publication (including persisted-message
recovery). Expired/tombstoned work is terminally refused. Unverifiable authority
uses the existing bounded retry/lease mechanism. Existing permanent channels
continue to work. No B1 policy, timeout, retry limit or authentication is relaxed.

PostgreSQL supplies expiry/tombstone state and the authoritative clock through
`channelLiveForMessageRead`; test-adapter checks alone are not PG evidence.
These are **preflight checks, not a transaction fence**. Expiry can still occur
between a check and insertion/finalization/publication. A committed message is
retained if the later check refuses publication; this change does not delete it
or prove atomic expiry-versus-write serialization.

## Production message-creation inventory

Source search: `Messages.create(`, `db.messages.insert(` and SQL `INSERT INTO
messages`, excluding test fixtures and generated output. This inventories message
creation, not all mutations of channel-related data.

| Production entry | Sink | Expiry status |
| --- | --- | --- |
| Socket.IO primary send, `socket/handlers/messages-send.ts` | `Messages.create` | #576 preflight; atomic race OPEN |
| Schedule POST and `jobs/scheduledMessages.ts` | Queue, then `Messages.create` | This PR adds repeated preflight; atomic race OPEN |
| Socket bridge forwarding and poll socket creation | `Messages.create` | Receiving-channel enforcement OPEN |
| `routes/voicemsg.ts` | `Messages.create` plus voice/upload state | OPEN; check before side effects and final commit required |
| `routes/bots.ts`, `lib/botInteractionReply.ts` | `Messages.create` | OPEN |
| `plugins/actions.ts` | `Messages.create` | OPEN |
| `jobs/autoModeration.ts`, `lib/automodRuntime.ts` | `Messages.create` | System/log destination checks OPEN |
| `routes/channelPerms/helpers.ts` | `Messages.create` | Audit/log destination checks OPEN |
| `routes/onboarding.ts`, `routes/serverTemplates.ts` | `Messages.create` | Welcome/template destination checks OPEN |
| `AnnouncementRepository.persistCrosspost` | Separate SQL transaction inserting `messages` and crosspost ledger | OPEN; bypasses common repository |
| `db/seed.ts` | Direct `db.messages.insert` | Bootstrap path; distinguish from public ingress |

`MessageRepository.create` currently inserts without an expiry transaction fence.
Adding checks only there would still miss the crosspost SQL transaction. Incoming
webhook routing, thread creation/replies, forum/poll tables, edits, reactions,
attachments, channel state mutations and federation need their own complete
ingress-to-commit audit. Do not infer coverage from the common message sink.

## Verification contract

Local focused run: 5 suites / 97 tests PASS, zero failed/skipped:
`scheduled-send-policy`, `jobs-scheduledMessages`, `scheduled`,
`scheduled-repository-behavior`, `channel-write-guard`.
Server typecheck, strict test typecheck (zero declared debt) and production build
PASS locally. A separate existing no-skips CLI self-test run was 5/6 on Windows:
its diagnostic-path assertion expects `/` while `path.relative` emits `\\`.
That platform discrepancy is preserved as a failure, not included in the 97
server-test result or treated as a successful gate.

New real-service suite: `scheduled-channel-expiry.pgtest.ts`.
It requires explicit PG and Redis URLs and fails rather than skips if absent.
It invokes the actual dispatcher, repositories, permission resolver, content
policy and Redis adapter. Only the socket publication recipient is observed by
an emitter. Controlled interleavings wrap real content verification/insertion;
neither operation is replaced by a fake successful operation.

The seven cases cover concurrent permanent-channel dispatch/retry, live expiring
channel, delayed expired work, tombstone precedence, expiry during content
verification, expiry after real insertion, and abandoned-lease recovery with an
already persisted message. Recovery is a persisted-state crash fixture, **not an
OS process-kill test**. The test after insertion intentionally proves retained
data and suppressed publication, not atomic rejection of the insert.

`.github/workflows/p7-scheduled-channel-expiry.yml` uses fresh PostgreSQL 16 and
Redis 7 service containers, verifies PG major version/PONG, applies the existing
schema/migration chain and enforces zero skipped tests. It has no secrets,
production connection, volume mount, deployment permissions or destructive
schema reset. Cleanup deletes only exact randomly generated fixture identifiers.
The general Quality Gate also discovers this suite against its PostgreSQL 18
service; that result must not be relabeled PG16.

First real-service CI: head `a6323aa1fdf27e950ddb590b4a31b5c4966c434c`,
run [40788727299](https://github.com/fatihcayiroglu/Bridge/actions/runs/40788727299),
job 123168323163: **PASS 7/7, zero skipped**, first attempt. Prerequisites measured
PostgreSQL version 160015 and Redis PONG. Original artifact 12860597268, SHA-256
`99a72fdcf5b342f5e3132e1d3dc6acc696023a1583addef147924dff4e008b3e`.
The next workflow revision additionally qualifies the focused 97-test regression
set, strict types and production build on Linux; its exact-head result must be
recorded separately. PostgreSQL/Redis remain unavailable locally; this is hosted
CI service evidence, not local or complete product E2E acceptance.

## Still required for D2 acceptance

- Supported owner-authorized expiry configuration with explicit approved bounds;
  schema 084's suggested lifetime range is not an approved product default.
- Every production write/side-effect path and atomic race boundary qualified.
- Authenticated stale-client/reconnect E2E and actual process restart/DB failure.
- Multiworker expiry/cleanup, tenant isolation and safe rollback evidence.
- Durable external-object cleanup and federation convergence without resurrecting
  tombstoned channels; retention/erasure/legal-hold policy requires owner decisions.
- No production data deletion, bulk cleanup or feature activation in this PR.
