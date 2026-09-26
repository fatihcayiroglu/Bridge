# PRODUCTION — Bridge v1.125.0

What running Bridge for real requires. Companion to `DEPLOYMENT.md` (architecture),
`STAGING.md` (pre-production), `CONFIGURATION.md` (variables) and the runbooks.

---

## 1. Minimum viable production

| Component | Requirement |
|---|---|
| PostgreSQL 18 | Required. Durable state. Backed up and restore-tested. |
| Redis | Required for the intended multi-instance/rate-limit/Socket.IO production topology. |
| Bridge server | Build the v1.125.0 source before pruning devDependencies. |
| Reverse proxy | TLS termination, WebSocket upgrade, correct `TRUSTED_PROXY_COUNT`. |
| Storage | Durable local volume or private S3-compatible storage for protected uploads. |
| Backup job | Scheduled PostgreSQL/storage backup with a restore rehearsal. |
| TURN / SFU | Required only for the voice topology/features you choose to expose. |

## 2. Non-negotiables before serving real users

- [ ] Production-required secrets are set through the deployment secret mechanism.
- [ ] `DATABASE_URL` points at the intended PostgreSQL database; no SQLite fallback exists.
- [ ] `TRUSTED_PROXY_COUNT` matches the real proxy hop count.
- [ ] `ALLOWED_ORIGINS` is restricted to intended origins.
- [ ] `WEBAUTHN_ORIGIN` / `WEBAUTHN_RP_ID` match the public origin.
- [ ] `/metrics` is access-controlled when metrics are enabled.
- [ ] Forward migrations and the required rollback rehearsal have passed against a disposable PostgreSQL database.
- [ ] Nightly backup is running **and a restore has actually been performed**.
- [ ] Health/readiness probes are wired into the orchestrator/load balancer.
- [ ] A responsible operator and incident/runbook path are defined.

## 3. What the repository proves vs. what deployment must prove

The source tree has automated contracts for release integrity, PostgreSQL migration
coverage/classification, product-surface wiring, security invariants, typechecking,
and test suites. A green repository gate is necessary, but it is not evidence that a
specific external production environment is healthy.

Run the repository/CI gates from a supported Node environment with dependencies
installed. The release artifact must also pass the dependency-free release-integrity
checks after fresh extraction.

The following remain environment-specific and must be demonstrated by the operator
before claiming them for a deployment:

| Area | Required evidence |
|---|---|
| Backup / restore | Restore a real backup into a disposable environment and validate application reads. |
| Multi-instance fan-out | At least two instances with the production Redis/Socket.IO topology. |
| Rolling / zero-downtime deploy | Rehearsed deployment while traffic is active. |
| Public TLS / proxy | Real domain, certificate, forwarded headers and WebSocket upgrade. |
| OIDC / SAML / SMTP | End-to-end round trips against the configured providers. |
| Object storage | Authenticated upload/read/delete plus backup/restore where applicable. |
| TURN / SFU voice | Real client/network paths, NAT traversal, reconnect/fallback and media flow. |
| Load / soak | Workload and concurrency representative of the expected user base. |
| Availability / SLO | Production telemetry over a meaningful observation window. |

Historical readiness notes are kept under `docs/changelogs/` as historical evidence,
not as a claim about the current release.

## 4. Operational baseline

Prometheus-compatible metrics, structured logs, health/readiness endpoints and
runbooks are included in the repository. The deployment owner must verify that
scraping, alert routing and log retention actually work in the target environment;
configuration files alone do not prove delivery.

Every request should remain traceable through its request identifier. Never copy
secrets, authorization headers, private keys or raw production credentials into
incident notes.

Do not claim an SLO until production measurements support it; see `OBSERVABILITY.md`.

## 5. Data protection

Treat account data, messages, uploads, session material, moderation/audit records and
infrastructure logs according to an explicit retention/deletion policy. Protected
uploads must remain private and be served only through the authenticated Bridge path.
Backups inherit the sensitivity of the data they contain and require the same access
controls.

No legal compliance claim is made by this document. Regulatory obligations depend on
the deployment, jurisdiction, data flows and operator policies.

## 6. Capacity and growth

Primary growth drivers are uploaded files, messages, audit/moderation records and
indexes. Monitor storage capacity, PostgreSQL growth/latency, Redis health, queue
backlogs and WebSocket/voice resource pressure.

Build capacity targets from measured staging/production workloads instead of
extrapolating from unit tests or a single development machine.
