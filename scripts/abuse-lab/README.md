# P7 B1 abuse lab

This lab measures Bridge abuse controls against a disposable **two-node** production-shaped cluster: PostgreSQL, Redis, S3-compatible storage and the existing routing proxy.

It is deliberately benchmark-first. Baseline mode records attack acceptance/blocking and legitimate-user false positives without pretending that an unmitigated scenario is a passing gate.

## Scenarios

- `ATK-01` — single-account channel burst
- `ATK-02` — exact duplicate-message flood
- `ATK-03` — single-message mass mention fan-out
- `ATK-04` — new-recipient DM spray paced below the outer socket gate
- `ATK-05` — multi-account join raid against one community, measured by post-join message delivery
- `LEG-01` — normal active conversation
- `LEG-02` — paced reconnect-like backlog
- `LEG-03` — one ordinary mention
- `LEG-04` — normal burst inside an existing DM conversation
- `LEG-05` — a few new DM recipients
- `LEG-06` — small legitimate join cohort + posting
- `LEG-07` — 40 established (>24h) accounts joining and posting during an organic launch surge

Channel/mention scenarios use separate authenticated senders so per-account spam and
socket windows cannot leak from an attack case into the next legitimate control.

The report contains accepted/blocked counts, false-positive flags, scenario durations, DM accepted/hour projection and before/after Bridge-node RSS.

## Run

```bash
python -m pip install 'moto[server]==5.2.3'
npm ci --no-audit --no-fund
(cd server && npm ci --no-audit --no-fund && npm run build)
MN_MOTO_SERVER=moto_server node scripts/abuse-lab/run.mjs --out /tmp/bridge-abuse
```

Baseline mode exits non-zero only for harness/product crashes. It does **not** turn currently open attacks into a fake CI failure before measured expectations exist.

A gated mode will be enabled only after the baseline and mitigated runs establish explicit checked-in expectations. Thresholds must not be guessed in this file.
