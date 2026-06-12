#!/usr/bin/env bash
# Yerel uçtan uca demo: Docker Compose → health → kayıt → mesaj API smoke test
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

ENV_FILE="${ROOT}/.env"
if [ ! -f "$ENV_FILE" ]; then
  cp .env.docker .env
  JWT="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  REF="$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")"
  PG="$(openssl rand -hex 16 2>/dev/null || node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")"
  sed -i.bak \
    -e "s/^JWT_SECRET=.*/JWT_SECRET=$JWT/" \
    -e "s/^REFRESH_SECRET=.*/REFRESH_SECRET=$REF/" \
    -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$PG/" \
    .env
  rm -f .env.bak
  echo "✅ .env oluşturuldu (rastgele secret'lar)"
fi

echo "🐳 Docker Compose başlatılıyor..."
docker compose up -d --build

BASE="http://localhost:3001"
echo "⏳ Health bekleniyor ($BASE)..."
for i in $(seq 1 60); do
  if curl -sf "$BASE/api/health" >/dev/null 2>&1; then
    echo "✅ Sunucu ayakta"
    break
  fi
  sleep 2
  if [ "$i" -eq 60 ]; then
    echo "❌ Sunucu 120s içinde başlamadı"
    docker compose logs bridge --tail 40
    exit 1
  fi
done

USER="demo_$(date +%s)"
PASS="DemoPass123!"

echo "👤 Kayıt: $USER"
REGISTER=$(curl -sf -X POST "$BASE/api/register" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}" || true)

if [ -z "$REGISTER" ]; then
  echo "ℹ️  Kayıt başarısız (kullanıcı var olabilir), giriş deneniyor..."
fi

LOGIN=$(curl -sf -X POST "$BASE/api/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"$USER\",\"password\":\"$PASS\"}")

TOKEN=$(echo "$LOGIN" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const j=JSON.parse(d);console.log(j.token||j.accessToken||'')}catch{}})")

if [ -z "$TOKEN" ]; then
  echo "❌ Giriş token alınamadı"
  echo "$LOGIN"
  exit 1
fi

echo "✅ Giriş başarılı"

ME=$(curl -sf "$BASE/api/me" -H "Authorization: Bearer $TOKEN")
echo "📋 Profil: $(echo "$ME" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{const u=JSON.parse(d);console.log(u.username||u.id)}catch{}})")"

echo ""
echo "🎉 Demo tamamlandı!"
echo "   Tarayıcı: $BASE"
echo "   Kullanıcı: $USER / $PASS"
echo "   Durdurmak: docker compose down"
