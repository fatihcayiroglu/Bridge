# BETA PLAN — Bridge v1.123

Goal: learn whether Bridge survives real use, with a blast radius small enough that
failure is recoverable.

---

## Phase A — 5 to 10 users

**Who:** people who know it is a beta and will report problems directly.

**Prerequisites (all met in v1.123):**

- Backup **and restore** actually executed and validated
- Redis outage recovery proven (`503` → `200` in 3 s, unattended)
- Full server and client suites green
- Chromium E2E green
- Production dependency audit: 0 vulnerabilities
- Private `.env` absent from the release artifact

**Operational requirements for Phase A:**

| Requirement | Why |
|---|---|
| Nightly `backup/backup.sh`, verified restorable at least once | RPO is 24 h and untested backups are not backups |
| Someone watching `bridge_http_errors_total` daily | There is no alerting yet |
| A named person on call | Runbooks need an operator |
| **Browser guidance: Chrome / Edge / Safari** | Firefox has a known reload defect — see §4 |
| Voice labelled experimental | Not validated under real network conditions |

**Duration:** minimum 2 weeks. Do not advance on a quiet week — quiet may mean nobody
used it.

**Exit criteria — all must hold:**

1. **Zero data loss.** No message, upload or account lost.
2. **Zero critical security incidents.** No auth bypass, no cross-tenant leak.
3. **Message reliability:** sent messages arrive and persist across reconnects.
4. **Reconnect works:** users recover from network changes without losing state.
5. **No uncontrolled memory growth** over a week of real use.
6. **A restore was performed at least once** against a real backup.
7. **Every incident has a postmortem** and its action items are closed.

## Phase B — 20 to 50 users

Enter only after Phase A exits cleanly.

**New risks at this size:**

- **Shared IPs become likely.** `MAX_WS_PER_IP = 10` means at most 10 concurrent users
  per public IP (measured). A single school or office will hit it. Review
  `CONFIGURATION.md §4` and set the limit deliberately *before* Phase B.
- Concurrency patterns unseen at 10 users
- Storage growth becomes measurable

**Add before Phase B:**

- Alerting on error rate and health (not just a human glancing at metrics)
- Load test at the expected concurrency (the v1.123 run covered 30 virtual users)
- Documented storage growth trend

**Exit criteria:** Phase A criteria, plus p95 latency stable under real load and no
unexplained restarts.

## Phase C — 100+

Only with evidence from Phase B. Requires, at minimum:

- Multi-instance deployment validated (never tested — `REDIS_URL` is mandatory there)
- Rolling deploy validated, or an accepted maintenance window
- Soak at target concurrency
- Cross-browser matrix complete, including the Firefox defect fixed
- Voice validated under real network conditions

---

## 4. Known limitations to communicate to beta users

Say these up front. A surprise is a support ticket; a stated limitation is a choice.

| Limitation | Impact |
|---|---|
| **Firefox: reloading the page can hang or show a blank app** | Measured and reproducible; caused by the service worker. Chromium and WebKit are unaffected. Recommend Chrome/Edge/Safari for the beta. |
| **10 concurrent users per public IP** | Everyone behind one school/office NAT shares that budget. |
| **Voice is experimental** | Not validated under real multi-network conditions. |
| **RPO is 24 hours** | A crash could lose up to a day of messages. |
| **No alerting yet** | Problems are found by humans looking, or by users reporting. |
| **Redis outage rejects all traffic** | Deliberate (fail-closed). Recovery is automatic. |

## 5. Feedback

Collect: what broke, what was confusing, what was slow, and what they expected to
exist and did not. Ask for the `X-Request-Id` from the network tab on any error — it
locates the exact request in the logs.

Keep a single running list. Triage weekly. Anything touching data loss or privacy
jumps the queue.
