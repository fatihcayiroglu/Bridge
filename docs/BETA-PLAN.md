# BETA PLAN — Bridge v1.123 (historical baseline; browser evidence updated 2026-10-16)

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
| **Browser guidance: Chromium/Chrome, Firefox and Safari/WebKit** | Core Playwright suites run on three engines. Firefox reload behavior was reclassified as a Playwright driver issue, not a proven Bridge app failure; physical Safari and media scenarios remain unverified — see §4. |
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
- Cross-browser matrix complete on the release candidate, including Firefox reload and real Safari user journeys; nightly engine tests alone are insufficient
- Voice validated under real network conditions

---

## 4. Known limitations to communicate to beta users

Say these up front. A surprise is a support ticket; a stated limitation is a choice.

| Limitation | Impact |
|---|---|
| **Firefox reload: historical automation-driver issue, not a confirmed product failure** | The old service-worker root-cause claim was disproven by isolation tests. `e2e/tests/cross-browser-journeys.spec.ts` checks a real in-page `location.reload()`, document replacement, rerender and session persistence. This regression passed in the 2026-10-16 nightly Firefox project. Recheck against real Firefox releases before beta sign-off. |
| **10 concurrent users per public IP** | Everyone behind one school/office NAT shares that budget. |
| **Voice is experimental** | Not validated under real multi-network conditions. |
| **RPO is 24 hours** | A crash could lose up to a day of messages. |
| **No alerting yet** | Problems are found by humans looking, or by users reporting. |
| **Redis outage rejects all traffic** | Deliberate (fail-closed). Recovery is automatic. |


### Cross-browser test evidence and its limits (2026-10-16)

The [scheduled full Quality Gate run 38861389494](https://github.com/fatihcayiroglu/Bridge/actions/runs/38861389494) passed: **Chromium 534/534, Firefox 28/28, WebKit 28/28**. The media project separately passed **33/33 on Chromium only**, using fake input devices. These are automated engine-level results on commit `89daecd1f0f74d96bee25ccfe108abcfaf2e0c83`, **not** tests of the latest branch or of actual Google Chrome/Safari consumer installations.

- Firefox and WebKit execute the scoped `cross-browser-core`, `cross-browser-journeys` and `cross-browser-product` suites, not every Chromium feature test. A green Firefox suite is useful but not a warranty that all sharing, audio and upload behavior works.
- The older Firefox service-worker reload warning was incorrect: the recorded reproduction still hung Playwright's `page.reload()` when the service worker was disabled. An ordinary in-page reload succeeded and the updated E2E checks both rerendering and persisted login. We must not describe the old driver hang as an established Firefox product defect.
- Playwright WebKit is **not** a physical macOS/iOS Safari user session. Real Safari permissions, screen capture, iOS storage policies and long-duration use remain release acceptance.
- For routine PRs, `E2E full + media` may be conditionally **SKIPPED**; do not count it as passed just because Quality Gate passes. Keep nightly green with zero retries, and rerun all three engines on the final release SHA.

## 5. Feedback

Collect: what broke, what was confusing, what was slow, and what they expected to
exist and did not. Ask for the `X-Request-Id` from the network tab on any error — it
locates the exact request in the logs.

Keep a single running list. Triage weekly. Anything touching data loss or privacy
jumps the queue.
