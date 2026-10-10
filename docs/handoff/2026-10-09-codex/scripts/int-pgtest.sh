#!/bin/bash
# HANDOFF COPY (2026-10-09): requires root (uses `su postgres` / network namespaces), PostgreSQL binaries
# (PGBIN), redis-server, moto_server (MOTO_SERVER) and installed Playwright browsers. Set S and W.
# Real PostgreSQL 16 + real Redis + S3-compatible endpoint (moto_server — NOT RustFS, NOT R2)
# for the integration tree's `test:pg`, mirroring CI's step incl. the zero-skip guard.
# Then the pgvector suite against a real `vector` extension.
S=${S:?set S to a writable scratch directory}
W=${W:?set W to the checkout under test}
B=${PGBIN:-/usr/lib/postgresql/16/bin}; D=/tmp/intpg/data; PORT=55481; RPORT=56381; SPORT=59081
cleanup() {
  su postgres -c "$B/pg_ctl -D $D -m fast stop" >/dev/null 2>&1 || true
  redis-cli -p $RPORT shutdown nosave >/dev/null 2>&1 || true
  [ -n "$MOTO" ] && kill $MOTO 2>/dev/null || true
}
trap cleanup EXIT
rm -rf /tmp/intpg; mkdir -p $D /tmp/intpgsock; chown -R postgres /tmp/intpg /tmp/intpgsock
su postgres -c "$B/initdb -D $D -U postgres --auth=trust >/dev/null"
su postgres -c "$B/pg_ctl -D $D -o '-p $PORT -k /tmp/intpgsock -c listen_addresses=127.0.0.1' -l $D/pg.log start -w >/dev/null"
su postgres -c "$B/psql -h 127.0.0.1 -p $PORT -U postgres -c \"CREATE ROLE bridge LOGIN SUPERUSER PASSWORD 'test_password'\" >/dev/null"
su postgres -c "$B/createdb -h 127.0.0.1 -p $PORT -U postgres -O bridge bridge_test"
su postgres -c "$B/createdb -h 127.0.0.1 -p $PORT -U postgres -O bridge bridge_vector"
redis-server --port $RPORT --bind 127.0.0.1 --save '' --appendonly no --daemonize yes >/dev/null
${MOTO_SERVER:-moto_server} -H 127.0.0.1 -p $SPORT > $S/int-moto.log 2>&1 &
MOTO=$!
for i in $(seq 1 50); do curl -s -o /dev/null http://127.0.0.1:$SPORT && break; sleep 0.2; done
URL="postgresql://bridge:test_password@127.0.0.1:$PORT/bridge_test"
cd $W/server
node --input-type=module <<NODE
import { S3Client, CreateBucketCommand, PutBucketPolicyCommand } from '@aws-sdk/client-s3';
const s3 = new S3Client({ endpoint: 'http://127.0.0.1:$SPORT', region: 'us-east-1', forcePathStyle: true,
  credentials: { accessKeyId: 'bridgereview', secretAccessKey: 'bridgereview123' } });
for (const Bucket of ['bridge-public', 'bridge-private']) {
  try { await s3.send(new CreateBucketCommand({ Bucket })); } catch (e) { if (e?.\$metadata?.httpStatusCode !== 409) throw e; }
}
await s3.send(new PutBucketPolicyCommand({ Bucket: 'bridge-public', Policy: JSON.stringify({ Version: '2012-10-17',
  Statement: [{ Sid: 'Pub', Effect: 'Allow', Principal: '*', Action: ['s3:GetObject'], Resource: ['arn:aws:s3:::bridge-public/*'] }] }) }));
console.log('buckets provisioned (moto)');
NODE
echo "== schema + migrations (as CI's earlier steps leave the service DB)"
DATABASE_URL=$URL JWT_SECRET=ci_jwt_secret_minimum_32_chars_value REFRESH_SECRET=ci_refresh_secret_minimum_32_chars \
  bash -c "npx ts-node --project tsconfig.json db/postgres/index.ts && npx ts-node --project tsconfig.json db/migrate-postgres.ts up" > $S/int-pg-schema.log 2>&1
echo "SCHEMA_EXIT=$?"
echo "== test:pg (PG16 + Redis + moto S3)"
PG_TEST_URL=$URL REDIS_TEST_URL=redis://127.0.0.1:$RPORT MINIO_TEST_ENDPOINT=http://127.0.0.1:$SPORT \
  npx jest --config jest.pg.config.js --runInBand --forceExit --json --outputFile=pg-jest-results.json 2>&1 | grep -vE '^\{"level"' | grep -E "^(PASS|FAIL)|Tests:|Test Suites:|●" | head -80
echo "PGTEST_EXIT=${PIPESTATUS[0]}"
node ../scripts/require-no-skipped-tests.js pg-jest-results.json --label "real PostgreSQL/Redis/S3 (moto)"
echo "GUARD_EXIT=$?"
echo "== search-it (live unified-search planner, schema from test:pg)"
SEARCH_IT_DATABASE_URL=$URL npm run -s test:search-it 2>&1 | grep -vE '^\{"level"' | grep -E "^(PASS|FAIL)|Tests:|●" | head -20
echo "SEARCHIT_EXIT=${PIPESTATUS[0]}"
echo "== pgvector suite (real vector extension, PG16)"
VURL="postgresql://bridge:test_password@127.0.0.1:$PORT/bridge_vector"
PGVECTOR_TEST_URL=$VURL PG_TEST_URL=$VURL npx jest --config jest.pg.config.js --runInBand --forceExit tests/pg-integration/pgvector-embedding.pgtest.ts 2>&1 | grep -vE '^\{"level"' | grep -E "^(PASS|FAIL)|Tests:|●" | head -30
echo "PGVECTOR_EXIT=${PIPESTATUS[0]}"
echo "== production SQL validated against PostgreSQL"
PG_TEST_URL=$URL node scripts/verify-sql-against-postgres.js 2>&1 | tail -4
echo "SQLCHECK_EXIT=${PIPESTATUS[0]}"
echo "== migration rollback gate (ordered chain)"
PG_TEST_URL=$URL node scripts/verify-migration-rollback.js --ordered 2>&1 | tail -4
echo "ROLLBACK_EXIT=${PIPESTATUS[0]}"
