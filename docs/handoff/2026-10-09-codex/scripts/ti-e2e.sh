#!/bin/bash
# HANDOFF COPY (2026-10-09): requires root (uses `su postgres` / network namespaces), PostgreSQL binaries
# (PGBIN), redis-server, moto_server (MOTO_SERVER) and installed Playwright browsers. Set S and W.
# Disposable PostgreSQL 16 + (optional) build + chosen e2e specs/project on wt-ti (PR #155 head).
set -e
S=${S:?set S to a writable scratch directory}
W=${W:?set W to the checkout under test}
D=/tmp/tie2epg/data; B=${PGBIN:-/usr/lib/postgresql/16/bin}; PORT=55471
if [ -f $D/postmaster.pid ]; then su postgres -c "$B/pg_ctl -D $D -m fast stop" >/dev/null 2>&1 || true; fi
rm -rf /tmp/tie2epg; mkdir -p $D /tmp/tie2esock; chown -R postgres /tmp/tie2epg /tmp/tie2esock
su postgres -c "$B/initdb -D $D -U postgres --auth=trust >/dev/null"
su postgres -c "$B/pg_ctl -D $D -o '-p $PORT -k /tmp/tie2esock -c listen_addresses=127.0.0.1' -l $D/pg.log start -w >/dev/null"
su postgres -c "$B/psql -h 127.0.0.1 -p $PORT -U postgres -c \"CREATE ROLE bridge LOGIN SUPERUSER PASSWORD 'test_password'\" >/dev/null"
su postgres -c "$B/createdb -h 127.0.0.1 -p $PORT -U postgres -O bridge bridge_test"
export DATABASE_URL="postgresql://bridge:test_password@127.0.0.1:$PORT/bridge_test"
export JWT_SECRET=ci_jwt_secret_minimum_32_chars_value
export REFRESH_SECRET=ci_refresh_secret_minimum_32_chars
export BASE_URL=http://127.0.0.1:3000
cd $W
if [ -z "$SKIP_BUILD" ]; then echo "== build"; npm run build > $S/ti-build.log 2>&1
(cd server && npm run build >> $S/ti-build.log 2>&1); fi
echo "== schema"; (cd server && npx ts-node --project tsconfig.json db/postgres/index.ts && npx ts-node --project tsconfig.json db/migrate-postgres.ts up) > $S/ti-schema.log 2>&1
rm -rf e2e/fixtures/tokens.json e2e/fixtures/run-id.txt e2e/fixtures/*.json 2>/dev/null || true
echo "== e2e ${PROJECT:-firefox} ${SPECS}"
cd e2e
set +e
npx playwright test -c ${CONFIG:-playwright.config.ts} ${SPECS} --project=${PROJECT:-firefox} --retries=0 --reporter=list ${EXTRA} --output=$S/ti-e2e-results
echo "E2E_EXIT=$?"
su postgres -c "$B/pg_ctl -D $D -m fast stop" >/dev/null 2>&1 || true
