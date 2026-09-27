# Bridge — Demo

## Canlı demo (GitHub Pages)

Statik tanıtım kaynağı:

**[`docs/demo/index.html`](demo/index.html)**

> Bu repoda GitHub Pages etkin değil. Tam özellikli sunucu için aşağıdaki yerel veya kendi VPS kurulumunu kullanın.

## 5 dakikada yerel demo

```bash
git clone https://github.com/fatihcayiroglu/Bridge.git
cd bridge
./scripts/demo.sh
```

Script otomatik olarak:

1. `.env` oluşturur (yoksa)
2. `docker compose up -d --build` çalıştırır
3. Health check bekler
4. Demo kullanıcı kaydı / girişi yapar
5. Tarayıcıda http://localhost:3001 adresini açmanız için bilgi verir

## CI testlerini yerelde çalıştırma

```bash
./scripts/ci-local.sh
```

Docker ile Postgres 16 + Redis 7 ayağa kalkar; ardından migration + `npm test` çalışır.

## E2E (Playwright)

```bash
# Önce demo sunucusu ayakta olsun
./scripts/demo.sh

cd e2e
npm install
npx playwright install chromium
BRIDGE_URL=http://localhost:3001 npm run test:smoke
```

## Kendi demo instance'ınız

Production demo için:

1. VPS + domain (ör. `demo.bridge.example.com`)
2. [DEPLOYMENT_GUIDE.md](../DEPLOYMENT_GUIDE.md) adımları
3. `ALLOWED_ORIGINS` ve `INSTANCE_URL` ayarlayın
4. Let's Encrypt ile HTTPS
