# P7 D2 poll route admission and response fencing — OPEN

This focused child starts at #617/#618 exact head
`478c4b2b907929716e9e6909a8327a25174276e7`, preserving the later integrated D2,
storage, desktop and Wayland histories. It does not replace those candidates or
qualify their inherited changes. It contains #375: no production main merge or
deployment is authorized. Abuse Lab B1 and native Android source are unchanged.

## Reproduced defect and correction

The poll's own expiration is separate from the parent channel's lifetime. Poll
create, vote, text edit, close, list and individual read previously succeeded
after the parent expired. Canonical channel unavailability also failed open.
The first regressions produced **1 PASS / 10 FAIL / 0 skipped**, preserved in
`bridge-p7-poll-expiry-red-20261030.json`, SHA-256
`05ce3a6d4615a15062dff0db59b2d29f2c035371d4afb9efaf4379bc3c779fa6`.

The six surfaces now reuse `channelContentAvailability`: the PostgreSQL tenant,
row, tombstone and database-clock authority, rather than a previously fetched
channel DTO. Existing authentication, visibility, membership, ownership,
timeouts, rate limits, moderation and atomic poll vote/edit rules remain.
Authorized unavailable channels yield the fixed 404; unverifiable authority
yields 503. Create/edit recheck after asynchronous content enforcement; writes
and list reads recheck before publishing an invalidation or returning content.

Authorized poll DELETE is left functional and tested for expired parents.
The follow-up below also fences vote-withdrawal responses while preserving the
existing authorized erasure. No new retention or account-erasure policy is selected.

## Initial source verification boundary (546daa2f)

- Four focused unit suites passed **113/113**, zero failed/skipped, on the final
  typed fixture source; the no-skips CLI independently validated the result. The new suite has 15 tests, including
  stale canonical DTO versus tombstone/DB-clock decisions, unavailable authority,
  expiry across content enforcement, atomic-result and list-read boundaries,
  and continued authorized deletion. The database query double in unit tests is
  not real PostgreSQL evidence.
- Production TypeScript passed. The strict test gate initially found one new
  mock missing required `createdAt`; the fixture now includes it. No type cast,
  suppression, debt baseline or threshold was added. The final strict gate passed
  with zero declared debt/errors across approximately 1,188 checked files.
- A wrong-working-directory Jest invocation collected zero tests; its failure
  JSON is preserved separately and never counted as PASS.
- Nine new PostgreSQL/Redis tests are mandatory in the existing isolated PG16
  workflow, with zero-skips checks and preserved JSON artifacts. They use the
  production HTTP routes, bearer validation/revocation, issuer and repositories.
  Tokens are issued to newly seeded disposable users. This is not password,
  PKCE, external-browser, TLS or full app integration evidence.
- Actual PG tests require explicit disposable PG/Redis URLs and cannot silently
  skip. No local services are available on this Windows host: new real-service
  results remain NOT EXECUTED until exact-head CI completes.

## Remaining acceptance

These are repeated preflights and response fences, not an atomic poll-table
expiry barrier. A vote can commit while live and the parent expire before the
postcheck. The real-PG interleaving explicitly expects that persisted vote to
remain while refusing HTTP success/content and socket invalidation; it never
pretends a rollback occurred. Direct poll repository writes, commit-time expiry,
cleanup races and the complete lifecycle need further
qualification. No active room eviction, device compatibility or P7 closure claim
follows from these tests. Keep the PR draft and P7/#321/#209 open.


## Withdrawal response follow-up

Review found an additional stale-content route: DELETE /:pid/vote removed the
vote but still returned the full poll question/options on an expired channel.
Two new regressions first produced **15 PASS /2 FAIL /0 skipped**, preserved in
bridge-p7-poll-withdrawal-red-20261030.json, SHA-256
`378d9642075056f403ad9a581c85102996a0219bc2997bf755df5e5a3906758c`.
The actual removal stays authorized and functional; only after removal do both
atomic and compatibility paths consult canonical availability before returning
content or invalidating the channel. Expired yields404, unverifiable503; neither
returns the stale question. This does not pretend that an erasure was rolled back.

The four local poll suites now pass **115/115**, zero skipped; production types
and the strict test gate pass with zero debt. The initial new assertion tried to
map an unknown mock-row field; it now compares the complete expected options
structure without casts, suppression or weakened assertions. A tenth mandatory real-PG case verifies a live vote is actually stored,
then removed after parent expiry, while the response is fixed404 and no
invalidation is emitted. The previously verified first head546daa2f run41012830673
(575 unit +232 realPG16/Redis) remains preserved. New-source exact-head CI is
required; the earlier PASS does not qualify this follow-up.
