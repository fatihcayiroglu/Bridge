#!/usr/bin/env bash
# CI ile aynı test ortamını yerelde çalıştırır (Docker Postgres + Redis gerekir).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export DATABASE_URL="${DATABASE_URL:-postgresql://bridge:bridge_test_pw@localhost:5432/bridge_test}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export JWT_SECRET="${JWT_SECRET:-test-secret-for-ci-min32chars-padding}"
export REFRESH_SECRET="${REFRESH_SECRET:-test-refresh-for-ci-min32chars-padding}"
export NODE_ENV=test

PG_CONTAINER="${BRIDGE_PG_CONTAINER:-bridge-ci-postgres}"
REDIS_CONTAINER="${BRIDGE_REDIS_CONTAINER:-bridge-ci-redis}"

cleanup() {
  docker rm -f "$PG_CONTAINER" "$REDIS_CONTAINER" 2>/dev/null || true
}
trap cleanup EXIT

echo "🐘 Postgres başlatılıyor..."
docker rm -f "$PG_CONTAINER" 2>/dev/null || true
docker run -d --name "$PG_CONTAINER" \
  -e POSTGRES_DB=bridge_test \
  -e POSTGRES_USER=bridge \
  -e POSTGRES_PASSWORD=bridge_test_pw \
  -p 5432:5432 \
  postgres:16-alpine >/dev/null

echo "🔴 Redis başlatılıyor..."
docker rm -f "$REDIS_CONTAINER" 2>/dev/null || true
docker run -d --name "$REDIS_CONTAINER" -p 6379:6379 redis:7-alpine >/dev/null

echo "⏳ Servisler hazırlanıyor..."
for i in $(seq 1 30); do
  if docker exec "$PG_CONTAINER" pg_isready -U bridge -d bridge_test >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

cd "$ROOT/server"
npm ci --ignore-scripts
node -r ts-node/register db/migrate-postgres.ts up
npm test
echo "✅ Tüm testler geçti"
