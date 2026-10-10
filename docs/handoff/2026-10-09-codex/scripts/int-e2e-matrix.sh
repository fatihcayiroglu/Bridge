#!/bin/bash
# HANDOFF COPY (2026-10-09): requires root (uses `su postgres` / network namespaces), PostgreSQL binaries
# (PGBIN), redis-server, moto_server (MOTO_SERVER) and installed Playwright browsers. Set S and W.
# Integration-tree E2E matrix in CI's e2e-full order, ONE shared database for the whole job
# (as CI does). Differences from CI, stated: PostgreSQL 16 (CI: 18-alpine); the s3-remote step
# uses moto_server (CI: RustFS) — neither is Cloudflare R2. Extra projects CI never runs
# (api-smoke in its own job, visual, perf) are run last and reported separately.
S=${S:?set S to a writable scratch directory}
W=${W:?set W to the checkout under test}
B=${PGBIN:-/usr/lib/postgresql/16/bin}; D=/tmp/intm/data; PORT=55491; SPORT=59091
OUT=$S/int-matrix; rm -rf $OUT; mkdir -p $OUT
cleanup() { su postgres -c "$B/pg_ctl -D $D -m fast stop" >/dev/null 2>&1 || true; [ -n "$MOTO" ] && kill $MOTO 2>/dev/null || true; }
trap cleanup EXIT
rm -rf /tmp/intm; mkdir -p $D /tmp/intmsock; chown -R postgres /tmp/intm /tmp/intmsock
su postgres -c "$B/initdb -D $D -U postgres --auth=trust >/dev/null"
su postgres -c "$B/pg_ctl -D $D -o '-p $PORT -k /tmp/intmsock -c listen_addresses=127.0.0.1' -l $D/pg.log start -w >/dev/null"
su postgres -c "$B/psql -h 127.0.0.1 -p $PORT -U postgres -c \"CREATE ROLE bridge LOGIN SUPERUSER PASSWORD 'test_password'\" >/dev/null"
su postgres -c "$B/createdb -h 127.0.0.1 -p $PORT -U postgres -O bridge bridge_test"
export DATABASE_URL="postgresql://bridge:test_password@127.0.0.1:$PORT/bridge_test"
export JWT_SECRET=ci_jwt_secret_minimum_32_chars_value REFRESH_SECRET=ci_refresh_secret_minimum_32_chars
export BASE_URL=http://127.0.0.1:3000
cd $W/server
(npx ts-node --project tsconfig.json db/postgres/index.ts && npx ts-node --project tsconfig.json db/migrate-postgres.ts up) > $OUT/schema.log 2>&1 || { echo "SCHEMA FAILED"; exit 1; }
cd $W/e2e; rm -f fixtures/tokens.json fixtures/run-id.txt
step() { # name, then playwright args
  local name=$1; shift
  echo "== $name"
  npx playwright test "$@" --retries=0 --reporter=list --output=$OUT/res-$name > $OUT/$name.log 2>&1
  local rc=$?
  echo "$name rc=$rc :: $(grep -E '^\s+[0-9]+ (passed|failed|flaky|skipped|did not run|interrupted)' $OUT/$name.log | tr -s ' ' | tr '\n' ' ')"
}
step chromium --project=chromium
WEBP_CONVERT=true step webp-enabled tests/webp-upload.spec.ts --project=chromium
${MOTO_SERVER:-moto_server} -H 127.0.0.1 -p $SPORT > $OUT/moto.log 2>&1 & MOTO=$!
for i in $(seq 1 50); do curl -s -o /dev/null http://127.0.0.1:$SPORT && break; sleep 0.2; done
(cd $W && MINIO_ENDPOINT=http://127.0.0.1:$SPORT MINIO_ACCESS_KEY=bridgereview MINIO_SECRET_KEY=bridgereview123 MINIO_BUCKET=bridge-public PRIVATE_MINIO_BUCKET=bridge-private node scripts/ci-provision-minio.mjs) > $OUT/s3-provision.log 2>&1; echo "s3 provision rc=$?"
WEBP_CONVERT=false CDN_PROVIDER=minio PRIVATE_STORAGE_PROVIDER=minio MINIO_ENDPOINT=http://127.0.0.1:$SPORT MINIO_ACCESS_KEY=bridgereview MINIO_SECRET_KEY=bridgereview123 MINIO_BUCKET=bridge-public PRIVATE_MINIO_BUCKET=bridge-private MINIO_PUBLIC_URL=http://127.0.0.1:$SPORT/bridge-public \
  step s3-remote-moto tests/remote-storage.spec.ts --project=s3-remote
kill $MOTO 2>/dev/null; MOTO=
step firefox --project=firefox
step webkit --project=webkit
step voice-media --project=voice-media
step mobile --project=mobile
for p in a11y a11y-mobile a11y-keyboard; do step $p --project=$p; done
echo "== not in CI e2e-full (reported separately)"
step api-smoke tests/smoke-health.spec.ts --project=api-smoke
step visual --project=visual
step perf --project=perf
echo MATRIX_DONE
