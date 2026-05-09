# ── Build stage ────────────────────────────────────────────────
FROM node:22-alpine AS build
WORKDIR /app

COPY package*.json ./
COPY server/package*.json ./server/

# Root devDeps (esbuild vs. client build için)
RUN npm ci
# Server devDeps (tsc için)
RUN cd server && npm ci

COPY . .

# 1. Server TypeScript → server/dist/
RUN cd server && npm run build

# 2. Client bundle → client/dist/
RUN npm run build

# ── Prod deps stage (runtime'a sadece prod deps gider) ──────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY server/package*.json ./server/
RUN cd server && npm ci --omit=dev

# ── Runtime stage ──────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /app

RUN addgroup -S bridge && adduser -S bridge -G bridge

# Derlenmiş kod
COPY --from=build /app/server/dist         ./server/dist
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/client/dist         ./client/dist

# Sadece production bağımlılıkları
COPY --from=deps /app/server/node_modules  ./server/node_modules

RUN mkdir -p /app/uploads /app/data && \
    chown -R bridge:bridge /app

USER bridge

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:3001/api/health || exit 1

CMD ["node", "server/dist/index.js"]
