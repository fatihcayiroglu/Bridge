# D2: do not renew expiry permission while a query response waits

Real PostgreSQL reproduced three stale-positive read decisions on unchanged
`afb67b3b`: a batch response captured while live but held until expiry; an earlier
batch chunk expiring while the next query waited; and single-message/media reads
whose live response reached the caller after expiry. Every delayed snapshot was
read from PostgreSQL and asserted live before the delay, then independently
asserted expired using the database clock before delivery. No PG row was mocked.
New unit baseline: 6 failed / 1 passed. Real PostgreSQL baseline: 3 failed / 3.

`liveChannelWindowsForRead` already computes conservative monotonic deadlines
from the database lifetime, but `liveChannelIdsForRead` discarded those deadlines
with `.keys()`. It now filters the existing windows at return, after all chunks.
The single-channel helper now subtracts elapsed query/transport time from its
database lifetime and denies when no positive window remains. It returns only
the remaining budget for media reuse. Permanent channels keep a null window.

The database remains authoritative for expiry. The process monotonic clock only
accounts for time elapsed since requesting the query; host wall-clock skew cannot
extend permission. Queue/planning time before the DB clock sample is included
conservatively and can shorten availability under contention. No new SQL query,
expiry classifier, migration, worker, cache or permission bypass is introduced.
Tenant/tombstone/corruption/error checks and the 500-ID chunk size remain.

This is a decision at helper return, not a promise that an arbitrary later action
is still authorized. Callers must retain their final read/publication/transaction
checks. Concurrent policy changes, other expiry paths and all #321/P7 acceptance
criteria still require their existing coverage; this change does not close #321.

Local evidence:

- Focused policy/deadline/availability suites: 65/65 tests in four suites.
  Controlled monotonic time tests just before, exactly at and after expiry;
  the previous exact database-window assertion remains exact with zero-latency
  fixture time. No assertion is weakened to a range.
- Real PostgreSQL: 12/12 tests in three suites, including delayed single/batch/
  multi-chunk regressions and adjacent message/search/saved/inbox authorization
  tests. Permanent/future channels remain available.
- Fresh, isolated disposable database and 93-version migration chain; existing
  fixture databases/data untouched. No production connection or data deletion.
- Canonical root/server typechecks and strict test TypeScript ratchet pass.
  Local dependency symlink and missing Electron-type setup errors were corrected
  by using matching-lockfile dependency trees, without changing source/types.
- Full local server coverage attempt exited 134 with V8 heap exhaustion before
  a result JSON/coverage verdict. It is **not a PASS**. Exact-head full CI with
  required real PostgreSQL/Redis/S3 and coverage gates remains necessary.

No production merge/deployment. #375 stays unmerged; #209/#321 remain open.
