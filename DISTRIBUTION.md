# Bridge — Dağıtım Paketi Kurulumu

Bu arşiv kaynak kod içerir; `node_modules` ve derlenmiş `dist/` dahil değildir.

## Hızlı başlangıç

```bash
# 1. Bağımlılıklar
npm install
cd server && npm install && cd ..

# 2. Ortam
cp server/.env.example server/.env
# server/.env → JWT_SECRET, REFRESH_SECRET, DATABASE_URL

# 3. PostgreSQL çalışıyor olmalı, sonra:
npm run build
npm start
```

Docker için kök dizinde:

```bash
cp .env.docker .env
# JWT_SECRET, REFRESH_SECRET, POSTGRES_PASSWORD doldur
docker compose up -d --build
```

## Zip yeniden oluşturma

```bash
npm run package:release
```

## Demo

```bash
./scripts/demo.sh
```

Detaylı rehber: [README.md](README.md) · [KURULUM.md](KURULUM.md) · [docs/DEMO.md](docs/DEMO.md)
