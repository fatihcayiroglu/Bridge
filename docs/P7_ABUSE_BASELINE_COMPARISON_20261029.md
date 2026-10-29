# Existing Abuse Lab outcomes: preserve scope and do not call all controls green

No B1 source, gate or classifier modified. The workflow is an existing automatic check, not a new acceptance waiver. P7 OPEN.

| Source | CI / job | Actual outcome |
| --- | --- | --- |
| Baseline #576104b60447b7ac69392994f5cc04c0c3153408538 | 40780241583 | Workflow PASS; attacks8BLOCKED/2LIMITED/0OPEN,controls15OK/1FRICTION/2FALSE_POSITIVE;gate.failures empty. Artifact12856233521 SHA256d65fd905da6fa42bee72af09646f2caaa4328afc33765f36314fccb5d9a9a806 downloaded/verified. |
| Integrated #587f7d548384406ee90b4dbc6b8f77d2dc8a81243b0 | 40849364752/job123364819947 | Workflow PASS; same category counts,gate.failures empty. Artifact12887226877 SHA2560428a34a18a023a798c258aa642c64fac0e2389572ff90d532c4396d4f8397ce downloaded/verified. |

The29 report entries use an outcome taxonomy, not Jest PASS/FAIL/SKIP counts. Do not label all29 tests PASS or claim every legitimate control succeeds. Specific inherited outcomes:
- LEG-02.700FRICTION:8/8delivered,1hold/1warning,no mute. Maximum delay2055ms baseline versus2058ms integrated; not a controlled timing difference.
- LEG-11FALSE_POSITIVE:40joined,0postedDuringHold,liftHTTP200,40releasedHolds,40postedAfterLift in both runs. Preserve the classifier's outcome; do not relabel it merely because final posts succeed.
- LEG-09FALSE_POSITIVE:30bans applied/10refused;30HTTP200/10HTTP429 in both runs. No quota/fixture change made to turn this green.

These exact matching control metrics establish that the observed categories predate this candidate. They do not prove every abuse scenario is unchanged or close P7 legitimate-control acceptance. The earlier integratedb10e08ea run40848726160 was automatically CANCELLED by the existing workflow concurrency when a new PR head arrived; not PASS. No manual rerun/cancel was used to hide a failure. The current completed result and original artifacts remain. Product policy/legitimate control follow-up remains separate from prohibited B1 changes.
