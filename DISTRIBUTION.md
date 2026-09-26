# Bridge — Dağıtım Paketi Kurulumu

Bu arşiv kaynak kod içerir; `node_modules` ve derlenmiş `dist/` dahil değildir.

## Hızlı başlangıç

```bash
# 1. Bağımlılıklar
npm install
cd server && npm install && cd ..

# 2. Ortam
cp server/.env.example server/.env
# server/.env → JWT_SECRET, REFRESH_SECRET, DATABASE_URL,
# FEDERATION_SECRET, AP_ENCRYPTION_KEY, METRICS_SECRET

# 3. PostgreSQL çalışıyor olmalı, sonra:
npm run build
npm start
```

Docker için kök dizinde:

```bash
cp .env.docker .env
# JWT_SECRET, REFRESH_SECRET, POSTGRES_PASSWORD, FEDERATION_SECRET,
# AP_ENCRYPTION_KEY ve METRICS_SECRET değerlerini değiştir
docker compose up -d --build
```

## Zip yeniden oluşturma

```bash
npm run package:release
```

Bu komut bağımlılıkları, coverage/build çıktılarını, `.git` verisini, özel
`.env` dosyalarını ve bilinmeyen çalışma-zamanı yüklemelerini dışlar. Ardından
`RELEASE_MANIFEST.sha256` üretir, ZIP'i yeni bir geçici dizine çıkarır, manifesti
ve 242 sticker checkpoint'ini doğrular; doğrulama bitmeden hedef ZIP'i yazmaz.

## Demo

```bash
./scripts/demo.sh
```

Detaylı rehber: [README.md](README.md) · [KURULUM.md](KURULUM.md) · [docs/DEMO.md](docs/DEMO.md)
