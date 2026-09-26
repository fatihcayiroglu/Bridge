# MULTI-INSTANCE — Bridge v1.124

**Status: EXECUTED + VERIFIED.** Cross-instance fan-out was the largest unproven
architectural claim in v1.123. It is now measured, and a real boot defect was found
and fixed along the way.

---

## 1. Topology tested

Two (then three) Bridge processes on **shared PostgreSQL and shared Redis**, separate
ports, identical configuration. No load balancer in front — clients were pointed at
specific instances so that "which instance served this?" is unambiguous.

```
  client A ─────► instance 1 (:3000) ─┐
                                      ├── shared PostgreSQL (durable state)
  client B ─────► instance 2 (:3010) ─┤
                                      └── shared Redis (fan-out, CSRF, rate limit)
                  instance 3 (:3020)
```

## 2. Boot race — DEFECT FOUND AND FIXED

Starting two instances **simultaneously** crashed one:

```
event=server.boot_error
DatabaseError: tuple concurrently updated
  at initSchema (db/postgres/index.js)
```

`CREATE TABLE IF NOT EXISTS` and `ALTER TABLE … IF NOT EXISTS` are individually safe,
but two sessions updating the same catalog row concurrently make PostgreSQL raise
this. Staggered starts worked; simultaneous starts did not.

This is exactly what horizontal scaling and rolling deploys do, so it was a genuine
blocker to running more than one instance.

**Fix:** `initSchema` now runs under a PostgreSQL **advisory lock**
(`pg_advisory_lock`). The lock lives in PostgreSQL itself (no new infrastructure), is
released automatically if the session dies (a crashed instance cannot hold it
forever), and changes no schema. Instances queue rather than collide; the second one
runs the same idempotent statements against an already-built schema and passes
quickly.

**Verified:** three instances started simultaneously → all `health=200`, **0 boot
errors**.

## 3. Cross-instance fan-out — 8/8

User A on instance 1, user B on instance 2, both in the same channel:

| Check | Result |
|---|---|
| Login on both instances | PASS |
| Server + channel created via instance 1 | PASS |
| B joined the server via instance 2 | PASS |
| Sockets connected to separate instances | PASS |
| **`message:new` crossed instance 1 → instance 2** | **PASS** |
| Payload carried the exact sent content | PASS |
| **`typing:update` crossed instances** | **PASS** |
| Message readable from instance 2 over REST | PASS |

A single-instance control run was executed first and also passed 8/8, so the
cross-instance result is not an artifact of a broken harness.

### Contract note discovered while testing

`connect` is **not** enough before emitting. The server establishes the
socket→user mapping after a database read and then emits `userAuthenticated`;
anything emitted before that is silently dropped. `e2e/helpers/socket.ts` documents
this, and the same race exists for real clients (which wait for
`bridge:socket-ready`). Early attempts failed for exactly this reason, not because
fan-out was broken.

Also measured: `channel:join` takes a **plain string** channel id, not an object.

## 4. Instance failure — 6/6

| Check | Result |
|---|---|
| Token issued on instance 1 accepted by instance 2 | PASS |
| CSRF token from instance 1 accepted by instance 2 | PASS |
| Socket connected to instance 2 | PASS |
| **Instance 2 healthy after instance 1 was killed** | PASS |
| Socket on instance 2 stayed connected | PASS |
| API still serving from instance 2 | PASS |

## 5. Sticky sessions

### **STICKY SESSIONS NOT REQUIRED**

Measured, not assumed:

- A JWT minted by instance 1 is accepted by instance 2 (stateless verification,
  authority read from the shared database).
- A **CSRF token obtained from instance 1 is accepted by instance 2** — the CSRF
  secret lives in shared Redis, so it is not instance-local.

This holds **only with `REDIS_URL` configured**. Without Redis, CSRF state and rate
limits become process-local and multi-instance breaks silently — users appear online
but never receive each other's messages, because the Socket.IO Redis adapter is what
carries fan-out.

## 6. What is still unproven

| Item | Status |
|---|---|
| A real load balancer in front (nginx upstream) | Not exercised end-to-end |
| Rolling deploy with version skew (old + new simultaneously) | Not tested |
| Fan-out under load (measurements were functional, not loaded) | Not tested |
| Presence healing across an instance loss at scale | Only single-socket verified |
| More than three instances | Not tested |

The functional claim — *messages and typing cross instances, sessions are portable,
and a lost instance does not take the cluster down* — is now evidence-backed. The
performance and deployment claims around it are not.
