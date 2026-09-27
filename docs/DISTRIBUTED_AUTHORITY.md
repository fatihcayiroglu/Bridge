# Distributed authority — what is shared, who owns it, what was proven

Scope: how Bridge behaves when it runs as **several independent processes**
behind a load balancer. Evidence comes from `scripts/multinode` — a disposable
cluster of real processes (three Bridge nodes, PostgreSQL, Redis, an
S3-compatible store, a routing load balancer and fault-injecting proxies for
PostgreSQL and object storage). How to run it: `scripts/multinode/README.md`.

Scenario ids (`AUTH-06`, `SFU-05`, …) refer to that harness's report. "Fast
test" names the regression test that runs in the normal Quality Gate.

**What this is not.** One host, loopback networking, three nodes. It is strong
evidence for distributed *correctness* (ownership, idempotency, fail-closed
behaviour, recovery). It is not production traffic, not a multi-host network
partition, not WAN/TURN media quality, not a load test and not an independent
audit. Those remain external (see the end of this document).

## Authority matrix

| Feature | Authoritative state (owner) | Node-local state / caches | Failure semantics (measured) | Evidence | Missing evidence |
|---|---|---|---|---|---|
| Access tokens | JWT signature + `users.tokenVersion` (PostgreSQL); `revoked:<jti>` (Redis) | token-version cache **bypassed** when `REDIS_URL` is set | DB down → 5xx, never stale success (PG-01); Redis down → 503 (RD-*-sec) | AUTH-01, ND-05, AUTH-08..12 | — |
| Refresh rotation | `refresh_tokens` rows, `SELECT … FOR UPDATE` family rotation (PostgreSQL) | none | concurrent race: exactly one winner, loser revokes the family (AUTH-06/07); COMMIT reply lost → blind retry is a replay (family revoked, re-login) (PG-04); lost before COMMIT → retry rotates (PG-05) | AUTH-03..07, PG-04/05, `concurrency.pgtest.ts` | — |
| Live session revocation | tokenVersion + Socket.IO adapter delivery to the socket's node | per-socket token timers | logout-all on A disconnects a socket on B in ~250 ms | AUTH-08/09 | — |
| CSRF tokens | Redis store, user-bound | none | issued on A, valid on B (AUTH-02); Redis down → 503 | AUTH-02, RD | — |
| WebAuthn challenges | Redis, consumed with an atomic take | none | concurrent completion on B and C consumes once | RD-01 | — |
| HTTP rate limits | Redis `rl:*` sorted sets | none in cluster mode | one budget cluster-wide (30, not 90, refreshes before 429 — AUTH-15); Redis refused/hung/OOM → 503 fail closed; a corrupt key fails closed for that user only (RD-E) | AUTH-15, RD-B, RD-E | — |
| Socket event rate limits / anti-spam | Redis | none | Redis down → events dropped silently (client sees its own timeout) | ND-02a, SFU-04i | — |
| WebSocket connection limits | Redis ZSET leases per IP / user | local counters | Redis restarted **empty** → every socket is dropped at its next lease heartbeat (≤30 s) and must reconnect (fail closed, by design) | RD-WS, SFU-04r | — |
| Realtime fan-out | Socket.IO Redis adapter (pub/sub) | local rooms | 3×3 exactly once, p50 ≈ 400 ms (RT-01); live delivery is at-most-once across a node death, durable history is authoritative (ND-03/04) | RT-01..06, ND-03/04 | — |
| Messages | `messages` + unique (`userId`, `ackId`) (PostgreSQL) | Redis ack-record cache | retries across nodes and concurrent duplicates → one row (RT-02/03, ND-02); **INSERT committed / reply lost → one row, correct ack, broadcast once** (PG-06, PG-06r — fixed in P1) | RT-02/03, ND-02, PG-06 | — |
| Presence | Redis `presence:sockets:<user>` ZSET (+ `presence:users` index, P1) | local socket map | **dead node's user shown offline** within ~stale window + reaper interval (ND-07, 85 s measured — fixed in P1) | RT-05, ND-07/08 | multi-host partition |
| Membership / channel access revocation | PostgreSQL members / overrides; live effect via adapter room leave + `membership:voice-evict` to the socket's node (P1) | `currentVoiceChannel`, SFU peer | kick / VIEW deny through another node: no text traffic, no voice injection, roster cleaned (STALE-01..05 — voice parts fixed in P1) | STALE-01..05 | — |
| P2P voice roster | Redis `voice:room:<ch>` with key lock | socket fields | Redis unavailable → join refused (no local fork) | STALE-03/05 | — |
| SFU room ownership | Redis `bridge:sfu:room:<ch>` + node lease `bridge:sfu:node:<id>` + registry epoch (P1) | mediasoup routers per node | race → one router (SFU-01); dead owner → takeover after the 30 s node lease (SFU-05 — fixed in P1); Redis data loss → no concurrent second router (SFU-08 — fixed in P1); registry down → fresh rooms refused (SFU-04) | SFU-01..08, `redis-sfu-ownership.pgtest.ts` | media quality (P2); multi-host partition |
| Stage rooms | Redis `stage:room:<ch>`; media revocation via `stage:media-revoke` to the SFU owner | SFU publishers | not executed in the harness | unit tests | cross-node stage scenario |
| Chunk-upload quota | Redis Lua (P0) | none | survives node death and restart (ND-06/10); Redis down → 503 | ND-06/10, RD chunk probes, `chunk-upload-quota-redis.pgtest.ts` | — |
| Chunk staging | node's upload root (`_chunks/`): per node (k8s `emptyDir`) or shared (compose volume); staging node recorded in Redis (P1) | the staged chunks | see **Chunked upload staging** below | UP-01..07, UP-02x, UP-06x | object-storage staging (not implemented) |
| Completed chunk uploads | Redis completion record per (user, upload id) for the session TTL (P1) | — | lost final response → any retry gets the same completion (UP-04 — fixed in P1) | UP-04 | — |
| Protected uploads | private bucket (S3) + `uploads` rows (PostgreSQL) | temp file | metadata fails → bytes rolled back (UPF-01); **metadata committed / reply lost → row and bytes kept, success** (UPF-02 — fixed in P1); storage refuses → nothing left (UPF-03); rollback also fails → orphan object logged, reclaimed by the unreferenced-upload sweep (UPF-04) | UPF-01..04 | — |
| Scheduled messages | `scheduled_msgs` claim `FOR UPDATE SKIP LOCKED` + 120 s lease (PostgreSQL) | none | 3 competing nodes → exactly once (JOB-01/02); crashed owner → dispatched once after the lease (JOB-03/04); claim COMMIT reply lost → once after the lease (PG-07, 120.5 s) | JOB-01..04, PG-07, `durable-queues.pgtest.ts` | — |
| Outgoing webhooks | queue claim + lease (PostgreSQL); at-least-once, `X-Bridge-Delivery` = queue row id | none | 3 workers → exactly once (JOB-05); owner killed mid-delivery → redelivered by a live node with the same delivery id (JOB-06, ~121 s) | JOB-05/06, `durable-queues.pgtest.ts` | — |
| Federation delivery | `ap_delivery_queue` claim `SKIP LOCKED` + lease + retry (PostgreSQL) | none | 3 nodes → each activity delivered once, queue drained (JOB-07) | JOB-07, `durable-queues.pgtest.ts` | — |
| Federation inbox | `ap_activities` partial-unique UPSERT + claim lease (PostgreSQL) | none | concurrent delivery of one activity → claimed once; processed → never reprocessed; dead claimant → taken over after lease | `federation-inbox-claim.pgtest.ts` (P1); an identical signature is additionally single-use cluster-wide (Redis replay claim) | **SKIPPED** in the harness: signed delivery needs an HTTPS key fetch from a non-internal host, which the SSRF guard (correctly) refuses on loopback; relaxing the guard to test it is not acceptable |
| Background jobs (automod, federation keys) | `pg_advisory_xact_lock` | none | not executed in the harness | unit tests | cross-node execution |
| Node liveness | Redis `node:alive:<id>` (30 s lease, P1) and `bridge:sfu:node:<id>` (SFU, P1) | — | used to tell live peers from dead ones (uploads, SFU) | UP-06x, SFU-05 | — |
| Readiness | DB ping + Redis PING **and a write** (P1) + storage | — | Redis refusing writes → 503 (RD-C-ready — fixed in P1); PostgreSQL down → 503, liveness 200 (PG-01) | RD-*-ready, PG-01 | — |
| Process survival | — | pooled PostgreSQL clients | a DB outage while a client was checked out **crashed the node** (PG-01 — fixed in P1); every fault now survived (PG-01b, PG-08) | PG-01b, PG-08, `pool-checked-out-client-loss.pgtest.ts` | — |

## Chunked upload staging — decision

Measured (UP-*): with **node-local** staging, a client whose chunks the load
balancer spreads across nodes could never finish — every chunk answered 200,
the upload never finalized, and four such uploads locked the user out of new
uploads for the 60-minute session TTL. The web client does not use this
endpoint; API clients (bots, SDKs, integrations) do, and they usually carry no
affinity cookie. With a **shared** upload root every case passes.

Decision: **B — staging must be node-independent.** Sticky sessions (A) hide
the problem only for cookie-keeping browsers and still lose every staged chunk
with the node.

Implemented in P1 (safe, focused):

- a misrouted chunk is refused explicitly — 409 `CHUNK_STAGED_ELSEWHERE` with
  the staging node — instead of a silent 200 (UP-02x);
- a session whose staging node is dead (node lease expired) or lost its staging
  is released and answered 409 `CHUNK_STAGING_LOST`; the user's quota slot is
  returned immediately (UP-06x);
- the completion of an upload is replayed to every retry (UP-04).

Supported multi-node configurations today: a shared upload volume
(`docker-compose.cluster.yml`; in Kubernetes a `ReadWriteMany` volume at the
upload root) — verified node-independent (UP-*-shared) — or load-balancer
affinity for cookie-keeping clients (UP-03). With the shipped Kubernetes
manifests (`emptyDir` + cookie affinity) cookie-less API clients cannot use
chunked uploads; they now get an explicit error instead of a hang
(`scripts/multinode/known-limitations.json`: UP-02-per-node, UP-06-per-node).

Not implemented — follow-up design (object-storage staging, node-independent
without a shared filesystem): stream each chunk to a local temp file under the
unchanged P0 lease/quota, then `PUT` it to the private bucket as
`chunk-staging/<sessionKey>/<index>-<sha256>`; record `index → sha256:size`
with `HSETNX` in Redis (duplicate = same hash, conflict = different hash);
completeness from the Redis index; finalization lock in Redis (`SET NX PX`);
merge by streaming the objects in order to a local file, then the existing
size / magic-byte / scan / SVG / WebP / upload / ownership pipeline; delete the
staged objects on close; a sweeper deletes `chunk-staging/` objects older than
the session TTL (the Redis index expires with the session). Staged objects must
stay outside the unreferenced-upload sweep's scope.

## Defects found and fixed in P1

| Scenario | Defect | Fix | Fast test |
|---|---|---|---|
| PG-01 | a DB outage crashed the node holding a checked-out client (unhandled `error`) | permanent client error listener; failed-ROLLBACK clients destroyed | `postgres-pool-owner`, `postgres-transaction-owner`, `pool-checked-out-client-loss.pgtest` |
| RD-C | readiness 200 while Redis refused every write | health check performs a bounded write; readiness failures logged per dependency | `redis-adapter-connected`, `health-operational-states` |
| STALE-02 | user kicked via another node kept injecting voice state / offers | P2P voice handlers require the socket to hold the voice room | `voice-eviction-cross-node` |
| STALE-03/05 | kicked / access-revoked user stayed in the voice roster (ghost), SFU peer kept | revocations run the real leave path on the socket's node (`membership:voice-evict`) | `voice-eviction-cross-node` |
| ND-07 | user of a dead node stayed online forever | `presence:users` index + reaper (exactly once cluster-wide) | `presence-cluster-contract`, `presence-reaper-redis.pgtest` |
| SFU-05 | dead room owner stranded the room for ~1 h | node lease + atomic takeover | `sfuRegistry-behavior`, `mediasoup-handlers`, `redis-sfu-ownership.pgtest` |
| SFU-08 | Redis data loss → second router for a live room | heartbeat re-assert + registry settle window | same |
| PG-06r | committed-but-reply-lost message acked, never broadcast | own row id resolves the ambiguity; normal broadcast | `messages-send` |
| UPF-02 | committed-but-reply-lost upload row pointed at deleted bytes | ownership re-checked before rollback; unknown → bytes kept | `upload-route-deep`, `upload` |
| UP-04 | lost final response → retry opened an orphan session | completion replay | `upload-chunk-session-locality` |
| UP-02/06/07 | silent non-finalization; dead node held the quota | explicit 409s, node liveness, quota release | `upload-chunk-session-locality`, `node-liveness` |

## Measurements (baseline, one host)

See the latest harness report for the full table. Representative values from
the P1 run: cross-node socket revocation ≈ 250 ms; cross-node message p50 ≈
400 ms; client reconnect after SIGKILL ≈ 350 ms; all in-flight sends acked ≈
10.4 s after SIGKILL (client retries at 1/s); node restart to ready ≈ 8.9 s;
PostgreSQL restart recovery ≈ 0.45 s; severed pools: 0/30 failed requests;
Redis recovery 1.4–4.8 s; worst probe while Redis hung ≈ 3.2 s (command
timeout bound); scheduled lease recovery ≈ 5 s; orphaned claim recovery ≈
120.5 s (120 s lease); webhook redelivery after owner death ≈ 121 s; presence
offline after a dead node ≈ 85 s.

## Remaining external evidence (not provided by this harness)

Multi-host production infrastructure and real network partitions; TURN/WAN
voice and video quality (P2); physical macOS/iOS devices; App Store / Play
Store review; code signing and notarization; an independent penetration test;
real production traffic; human screen-reader validation.
