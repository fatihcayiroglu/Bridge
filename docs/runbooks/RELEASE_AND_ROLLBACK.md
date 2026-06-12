# Bridge Release, Auto-Update ve Rollback Runbook

Bu runbook, Bridge'i production kalitesinde çıkarmak için takip edilecek standart akıştır. Amaç; yeni sürümün build, test, güvenlik, desktop auto-update ve rollback süreçlerinin tek listeden yönetilmesidir.

## 1. Sürüm öncesi kalite kapısı

Yerelde veya CI'da aynı komutu çalıştır:

```bash
npm run quality:gate
```

Hızlı doğrulama için:

```bash
FAST=1 npm run quality:gate
```

Bu komut şunları kontrol eder:

- root, server ve Electron `npm audit --audit-level=high`
- TypeScript typecheck
- strict client typecheck
- Svelte check
- client/server/mobile/Electron build
- server, Electron ve mobile testleri
- production preflight
- Playwright smoke test listesinin üretilebilirliği

## 2. Production preflight

Production'a çıkmadan önce:

```bash
npm run deploy:preflight
```

Bu kontrol ağ gerektirmez ve şunları doğrular:

- `Dockerfile`, `docker-compose.prod.yml`, kalite workflow'u ve runbook dosyaları mevcut mu?
- Container non-root çalışıyor mu?
- `read_only`, `no-new-privileges` ve `cap_drop` aktif mi?
- `/api/health/live` ve `/api/health/ready` endpoint'leri var mı?
- `/metrics` endpoint'i `METRICS_SECRET` ile korunuyor mu?
- Electron release metadata dosyaları GitHub Release'e yüklenecek mi?

## 3. Production Docker çalıştırma

İlk kurulum:

```bash
cp .env.docker .env
# .env içindeki CHANGE_ME değerlerini doldur
npm run compose:prod:config
npm run compose:prod:up
```

Önerilen secret üretimleri:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))" # JWT/refresh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" # AP/Metrics/Federation
openssl rand -hex 32 # Postgres password
```

Sağlık kontrolü:

```bash
curl -fsS http://localhost:3001/api/health/live
curl -fsS http://localhost:3001/api/health/ready
```

## 4. Desktop auto-update release akışı

1. `package.json`, `server/package.json`, `electron/package.json` ve gerekiyorsa mobile sürümlerini aynı semver değerine çek.
2. Kalite kapısını çalıştır:

   ```bash
   npm run quality:gate
   ```

3. Git tag oluştur:

   ```bash
   git tag v1.123.0
   git push origin v1.123.0
   ```

4. `Electron Release` workflow'unun Windows/macOS/Linux artifact ve `latest*.yml` metadata dosyalarını GitHub Release'e yüklediğini doğrula.
5. Draft release ise notları kontrol edip publish et.

## 5. Rollback

### Server rollback

Docker imajını tag bazlı tutuyorsan:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml pull bridge
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d bridge
```

Önceki git tag'e dönmek gerekiyorsa:

```bash
git checkout v1.122.0
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build bridge
```

DB migration geri dönüşleri risklidir. Migration irreversible ise önce snapshot/backup restore planı uygulanmalı.

### Desktop rollback

Electron auto-update için en güvenli rollback:

1. Eski stabil sürümü GitHub Release'te tekrar latest/stable olarak yayınla.
2. Yeni sürüm release'ini draft yap veya prerelease'e çek.
3. `latest.yml`, `latest-mac.yml`, `latest-linux.yml` metadata dosyalarının eski sürüme işaret ettiğini kontrol et.
4. Client'lar bir sonraki update kontrolünde eski stabil sürümü alır.

## 6. Yayın sonrası smoke checklist

- `/api/health/live` 200 dönüyor.
- `/api/health/ready` 200 dönüyor.
- `/metrics` secretsiz 401/503, doğru Bearer token ile 200 dönüyor.
- Yeni kullanıcı kayıt/giriş akışı çalışıyor.
- Mesaj gönderme/alma çalışıyor.
- Dosya upload güvenlik kontrolleri çalışıyor.
- Desktop menüsünden “Güncellemeleri Kontrol Et” akışı hata vermiyor.
- GitHub Release artifact'larında `latest.yml`, `latest-mac.yml`, `latest-linux.yml` mevcut.
