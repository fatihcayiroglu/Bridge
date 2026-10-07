# P7 B2 step-up lab

Measures, on a real two-node Bridge cluster (`NODE_ENV=production`, shared PostgreSQL + Redis —
the multinode harness in `../multinode/lib`), what a **stolen session** (a valid access token /
refresh cookie without the person's credentials) can do to high-risk actions, and the cadence of
the **legitimate operator** the step-up must not punish.

```
MN_MOTO_SERVER=moto_server node scripts/stepup-lab/run.mjs [--scenarios a,b] \
  [--out DIR] [--label NAME] [--gate] [--keep]
```

- **Baseline** (current `main`, before step-up): run without `--gate`. Every attack is `OPEN`
  and the legitimate scenarios measure the per-action cadence that sets the burst thresholds.
- **After B2**: run with `--gate`, which fails if a legitimate control false-positives (other
  than a documented `knownFalsePositive` in `expectations.json`) or an attack is weaker than its
  recorded floor (`OPEN < STEPUP < BLOCKED`).

Outcomes: attacks `OPEN` / `STEPUP` (refused with `403 STEP_UP_REQUIRED`) / `BLOCKED`; controls
`OK` / `FRICTION` (one explainable proof, then continued) / `FALSE_POSITIVE`. Every simulated
person has its own client address and the clients alternate nodes, so a grant minted on one node
must verify on the other. Measured numbers and the design live in
`docs/P7_TRUST_SOCIAL_FOUNDATION.md` (§ B2).
