# Multi-node evidence harness

Distributed-correctness scenarios against a **disposable cluster of real
processes** — not service objects inside one Node process:

| Component | Process | Port |
|---|---|---|
| Bridge nodes A, B, C | `node server/dist/index.js`, `NODE_ENV=production`, `BRIDGE_MULTI_NODE=true`, `INSTANCE_ID=mn-<name>` | 3101–3103 |
| Load balancer | `lib/proxy.mjs` (HTTP + WebSocket): round-robin, cookie affinity (`MNNODE`), pin, `x-mn-node` forcing, `?bridgeNode=mn-<name>` SFU routing (same contract as `haproxy/haproxy.cluster.cfg`), node removal, passive failover | 3100 |
| PostgreSQL | `initdb`/`pg_ctl` (binaries from `/usr/lib/postgresql/*/bin` or `MN_PG_BIN`) | 55432 |
| PostgreSQL fault proxy | `lib/faultProxy.mjs` `PgFaultProxy`: cut all connections, refuse, COMMIT reply lost, SQL-targeted reply-lost / fail-before-execute | 55433 (what the nodes use) |
| Redis | `redis-server` (stop, SIGSTOP hang, kill clients, reject writes via maxmemory) | 56379 |
| S3-compatible storage | `moto_server` (`MN_MOTO_SERVER`) or external `MN_S3_ENDPOINT` | 59000 |
| S3 fault proxy | `lib/faultProxy.mjs` `HttpFaultProxy`: fail chosen HTTP methods (PUT/DELETE) with 503 | 59001 (what the nodes use) |

Shared state: PostgreSQL, Redis, both buckets. Node-local state: process
memory, mediasoup workers, and the upload root (`--uploads per-node`, like
Kubernetes `emptyDir`) unless `--uploads shared` (like the compose volume).
`TRUSTED_PROXY_COUNT=1`; each simulated client sends its own X-Forwarded-For.

Harness-only settings (never production): `RL_REGISTER_MAX`,
`MAX_REG_PER_HOUR`, `RL_LOGIN_MAX` raised for fixture creation;
`ALLOW_INTERNAL_WEBHOOKS=true` + `SSRF_ALLOWLIST=localhost` for the loopback
webhook receiver. Every other protection runs at its production default.

## Running

```sh
cd server && npm ci && npm run build && cd ..
python -m pip install 'moto[server]==5.2.3'
MN_MOTO_SERVER=moto_server node scripts/multinode/run.mjs                 # every scenario, per-node uploads
MN_MOTO_SERVER=moto_server node scripts/multinode/run.mjs --scenarios uploads --uploads shared
```

Options: `--scenarios a,b`, `--uploads per-node|shared`, `--work DIR`,
`--out DIR`, `--keep` (leave the cluster running). When run as root,
PostgreSQL runs as the `postgres` account (`MN_PG_OS_USER`).

Output: `report.json` / `report.md` (topology with versions and ports, every
check, measurements) plus every process log under `<work>/logs/`.

Statuses: `PASS`, `FAIL`, `BLOCKED`, `SKIPPED`, `INFO`. Skipped and blocked
never count as pass. `known-limitations.json` names individual checks that fail
for a verified, documented reason — they stay `FAIL` in the report and do not
fail the exit code; a listed check that starts passing fails the run.

## Scenarios

| Scenario | What it proves |
|---|---|
| `auth` | tokens, CSRF, refresh rotation/replay/race, logout-all and password change across nodes; cluster-wide refresh rate limit |
| `realtime` | 3×3 fan-out exactly once, ackId idempotency across nodes, typing, presence, non-member isolation |
| `stale` | kick / channel-permission revocation decided on one node reaches sockets, voice state and voice roster on another |
| `nodedeath` | SIGKILL mid-stream: reconnect, no durable loss/duplicate, quota and auth survive, presence of the dead node's user |
| `redis` | refused / killed connections / rejected writes / hung / corrupt key: fail-closed, readiness, recovery without restart |
| `postgres` | crash + restart, severed pools, COMMIT-reply-lost and fail-before-commit on refresh rotation, message insert, job claim; no node crash |
| `jobs` | scheduled messages (SKIP LOCKED + lease, owner death), outgoing webhooks (owner death, at-least-once with delivery id), federation delivery queue |
| `sfu` | room ownership race, redirect contract, route mismatch, registry outage, owner death takeover, Redis data loss (router-interval overlap detector) |
| `uploads` | chunked upload across nodes (round-robin, affinity, retry, conflict, node death, quota) and protected-upload storage/metadata failure paths |

CI ownership: `.github/workflows/multinode-evidence.yml` (weekly + manual).
The fast regression tests for every defect found here run in the normal
Quality Gate. Findings, fixes and measurements: `docs/DISTRIBUTED_AUTHORITY.md`.

A disposable three-node cluster on one host is strong evidence for
distributed correctness. It is not production traffic, a multi-host network
partition, WAN media quality, or an independent audit.
