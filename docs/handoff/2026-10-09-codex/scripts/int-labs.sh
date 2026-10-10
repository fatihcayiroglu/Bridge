#!/bin/bash
# HANDOFF COPY (2026-10-09): requires root (uses `su postgres` / network namespaces), PostgreSQL binaries
# (PGBIN), redis-server, moto_server (MOTO_SERVER) and installed Playwright browsers. Set S and W.
# Weekly-only labs (never run on PRs) against the five-PR integration tree, with CI's own
# scenario lists. Local differences: the runner is this container, not ubuntu-latest.
S=${S:?set S to a writable scratch directory}
W=${W:?set W to the checkout under test}
cd $W
export MN_MOTO_SERVER=${MOTO_SERVER:-$(command -v moto_server)}
rm -rf $S/int-mn-* $S/int-ml-*
echo "== multinode per-node uploads (all scenarios)"
node scripts/multinode/run.mjs --scenarios 'auth,realtime,stale,nodedeath,redis,postgres,jobs,sfu,uploads' --uploads per-node \
  --work $S/int-mn-pernode --out $S/int-mn-pernode-report > $S/int-mn-pernode.log 2>&1
echo "MN_PERNODE_EXIT=$? $(grep -E "^summary|TOTAL" $S/int-mn-pernode.log)"
echo "== multinode shared uploads (uploads)"
node scripts/multinode/run.mjs --scenarios 'uploads' --uploads shared \
  --work $S/int-mn-shared --out $S/int-mn-shared-report > $S/int-mn-shared.log 2>&1
echo "MN_SHARED_EXIT=$? $(grep -E "^summary|TOTAL" $S/int-mn-shared.log)"
echo "== media lab (all scenarios, SOAK_MINUTES=20 as CI)"
SOAK_MINUTES=20 node scripts/medialab/run.mjs --scenarios 'e2e,turn,impair,netchange,failover,lifecycle,authz,multiuser,soak' \
  --work $S/int-ml --out $S/int-ml-report > $S/int-ml.log 2>&1
echo "ML_EXIT=$? $(grep -E "^summary|TOTAL" $S/int-ml.log)"
echo LABS_DONE
