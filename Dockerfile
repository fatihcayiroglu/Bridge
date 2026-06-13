# ════════════════════════════════════════════════════════════════
# Bridge — Production Dockerfile
# Sprint 50 Security Fix: güvenli multi-stage build
#
# GÜVENLİK NOTLARI:
#   • Build sırasında hiçbir secret/env inject edilmez — runtime'da .env'den okunur.
#   • node:22-alpine minimal attack surface — bash, curl yok.
#   • Non-root kullanıcı (bridge:bridge) — container breakout riski minimize.
#   • Runtime image'da devDependencies yok — npm audit surface küçültülmüş.
#   • /app/uploads dışındaki dosya sistemi read-only çalışabilir (docker compose'da
#     read_only: true + tmpfs eklenebilir, bkz. DEPLOYMENT_GUIDE.md).
#   • HEALTHCHECK wget ile (curl yok) — Alpine default araçlarıyla.
# ════════════════════════════════════════════════════════════════

# ── Stage 1: Bağımlılık kurulumu + Build ────────────────────────
FROM node:22-alpine AS build

# Güvenlik: build sırasında gereksiz araçları kaldır
RUN apk add --no-cache python3 py3-pip make g++   # mediasoup native build için

WORKDIR /app

# Önce sadece package.json — layer cache'i build adımından ayırmak için
COPY package*.json ./
COPY scripts ./scripts
COPY server/package*.json ./server/

# Root devDeps (esbuild + client build için)
RUN npm ci --ignore-scripts=false
# Server devDeps (tsc + ts-jest için)
RUN cd server && npm ci --ignore-scripts=false

COPY . .

# 1. Server TypeScript → server/dist/
RUN cd server && npm run build

# 2. Client bundle → client/dist/
RUN npm run build

# ── Stage 2: Sadece production bağımlılıkları ──────────────────
FROM node:22-alpine AS deps
WORKDIR /app
RUN apk add --no-cache python3 py3-pip make g++   # mediasoup native modülleri için
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev --ignore-scripts=false

# ── Stage 3: Minimal runtime image ─────────────────────────────
FROM node:22-alpine AS runtime

# Güvenlik: imajı minimal tut — sadece wget (healthcheck için)
RUN apk add --no-cache wget \
 && rm -rf /var/cache/apk/*

WORKDIR /app

# Non-root kullanıcı oluştur
RUN addgroup -S bridge && adduser -S bridge -G bridge

# Derlenmiş server kodu
COPY --from=build /app/server/dist         ./server/dist
COPY --from=build /app/server/package.json ./server/package.json

# Derlenmiş client kodu
COPY --from=build /app/client/dist         ./client/dist

# Production bağımlılıkları
COPY --from=deps  /app/server/node_modules ./server/node_modules

# Uploads + data dizinleri — sadece bunlar yazılabilir (kod: server/dist → ../uploads)
RUN mkdir -p /app/server/uploads /app/server/uploads/_quarantine /app/data \
 && chown -R bridge:bridge /app \
 && chmod 750 /app/server/uploads /app/data

# Non-root olarak çalış
USER bridge

# Yalnızca container-internal — reverse proxy (nginx/caddy) dışarı yönlendirir
EXPOSE 3001

# ── Güvenlik kontrol noktası ─────────────────────────────────
# JWT_SECRET ve REFRESH_SECRET eksikse server/middleware/auth.ts zaten
# process.exit(1) ile durur. Dockerfile'da bu değerler ARG/ENV olarak
# TANIMLANMAMALI — secret'lar yalnızca runtime'da .env / docker secrets
# / k8s secrets üzerinden inject edilmelidir.
# Bkz. DEPLOYMENT_GUIDE.md → "Güvenli Secret Yönetimi"

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health/ready || exit 1

CMD ["node", "server/dist/index.js"]
