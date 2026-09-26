# RUNBOOK — INCIDENT MANAGEMENT

---

## 1. Severity

| Sev | Definition | Examples | Response |
|---|---|---|---|
| **SEV-1** | Service unusable, or data at risk | All requests `503`; data loss; auth bypass; cross-tenant leak | Immediate, all hands |
| **SEV-2** | Major feature broken, core works | Voice down; uploads failing; a server unreachable | Same day |
| **SEV-3** | Degraded or cosmetic | Slow endpoint; UI defect with a workaround | Next working day |

Anything involving **data loss, credential exposure, or one user seeing another
user's content is SEV-1** regardless of how few users are affected.

## 2. Roles

- **Incident lead** — decides; does not debug
- **Operator** — executes commands
- **Scribe** — timestamps every action and observation
- **Communicator** — talks to users

In a 5–10 person private beta one person may hold several roles, but the *lead*
should not also be the one typing.

## 3. Flow

**Detect** → alert, or a user report.

**Contain first, diagnose second.** Restore service before finding root cause. The
exception is suspected data corruption: stop writes *before* anything else, because
every second of continued writing enlarges the damage.

**Assess:**
```bash
curl -s /api/health
curl -s /metrics | grep -E "bridge_http_errors_total|bridge_active_sockets"
grep -o '"event":"[a-z_.]*"' /var/log/bridge.log | sort | uniq -c | tail -20
```

Every log line carries a `requestId` (and `userId` once authenticated). A user
reporting "I got an error" can read `X-Request-Id` from their browser's network tab —
that single value locates the exact request server-side. Use it.

**Recover** — the matching runbook:

| Symptom | Runbook |
|---|---|
| All requests `503`, rate-limit authority errors | `RUNBOOK-REDIS-OUTAGE.md` |
| Data wrong or missing | `RUNBOOK-DATABASE-RESTORE.md` |
| Started right after a deploy | `RUNBOOK-ROLLBACK.md` |
| Voice only | `RUNBOOK-VOICE-DEGRADED.md` |

**Verify** — health `200`, login works, two clients exchange a message, error rate
flat for 15 minutes.

**Communicate** — for a private beta, a short honest message beats silence:
what broke, what it affected, whether data was lost, what happens next.

## 4. Postmortem template

Within 48 hours, blameless.

```markdown
# Postmortem — <short title>
**Date:** YYYY-MM-DD   **Severity:** SEV-n   **Duration:** Xh Ym

## Impact
Who was affected, what they could not do, whether any data was lost.

## Timeline (UTC)
HH:MM  first symptom
HH:MM  detected (how?)
HH:MM  responded
HH:MM  mitigated
HH:MM  resolved

## Root cause
The actual mechanism. Not "a bug" — the specific chain.

## Detection
How did we find out? If a user told us before monitoring did, that is a finding
in its own right.

## What went well

## What went badly

## Action items
| # | Action | Owner | Due |
|---|--------|-------|-----|

## Lessons
Which class of failure was this? What else in the system shares that shape?
```

The last question is the valuable one. In this project, two separate
production 500s came from the *same* class — a schema/allowlist drift — and were
only closed for good when a self-maintaining invariant replaced hand-written
per-column assertions. Ask what class a defect belongs to, then close the class.
