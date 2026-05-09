# Bridge — Session 8 Fix Notları

**Tarih:** Mayıs 2026
**Kapsam:** 6 eksik / bug düzeltmesi

---

## Fix 1 🔴 Socket.IO — Redis Adapter eksikti (clustering)

**Sorun:** `server/lib/redisAdapter.js` içinde `applyAdapter()` fonksiyonu yazılmıştı ama `server/socket/index.js` içinde hiç çağrılmıyordu. Birden fazla instance çalıştırıldığında (docker compose cluster, k8s) Socket.IO event'leri instance'lar arası paylaşılamıyordu: kullanıcı A hangi node'a bağlıysa sadece o node'un mesajlarını alıyordu.

**Düzeltme — `server/socket/index.js`:**
- `applyAdapter` import'u eklendi: `const { cache: _rateCache, applyAdapter } = require('../lib/redisAdapter');`
- `setupSocket(io)` fonksiyonunun başına `applyAdapter(io)` çağrısı eklendi
- `REDIS_URL` tanımlıysa Redis adapter aktif olur, tanımlı değilse in-memory modunda devam eder (log uyarısı verilir)

**Kullanım:**
```env
# .env dosyasına ekle:
REDIS_URL=redis://localhost:6379
```

---

## Fix 2 🔴 Rate Limit — Redis `reconnectStrategy: false` hatası

**Sorun:** `server/middleware/rateLimit.ts` içinde Redis client `reconnectStrategy: false` ile oluşturuluyordu. Redis bağlantısı bir kez düştüğünde client otomatik reconnect yapmıyor, process restart'a kadar in-memory modunda kalıyordu. Cluster ortamında bu süre zarfında rate limit counter'ları node'lar arası senkronize edilemiyordu.

**Düzeltme:**
```ts
// Önce:
socket: { connectTimeout: 3000, reconnectStrategy: false }

// Sonra:
socket: { connectTimeout: 3000, reconnectStrategy: (retries) => {
  if (retries > 10) return new Error('Redis rate-limit: 10 bağlantı denemesi başarısız');
  return Math.min(retries * 300, 3000); // üstel backoff, max 3s
}}
```

---

## Fix 3 🟠 Push Notification — FCM token thundering herd

**Sorun:** `getFcmAccessToken()` eşzamanlı çağrıldığında (10 kullanıcıya aynı anda push gönderilince) token süresi dolmuşsa her çağrı ayrı bir OAuth2 isteği açıyordu. Google'ın rate limit'ine çarpma riski vardı.

**Düzeltme — `server/lib/pushSender.js`:**
- `_fcmRefreshPromise` mutex eklendi
- Token yenileme devam ediyorken gelen çağrılar aynı Promise'i bekler
- `finally` bloğunda mutex serbest bırakılır

---

## Fix 4 🟠 Push Notification — retry mekanizması eksikti

**Sorun:** `sendWebPush()` ağ hatası veya geçici 5xx durumunda sessizce başarısız oluyordu. Bildirimler kayboluyordu.

**Düzeltme — `server/lib/pushSender.js`:**
- `_withRetry(fn, maxAttempts=3, baseDelayMs=500)` helper eklendi
- Exponential backoff: 500ms → 1000ms → 2000ms
- Kalıcı hatalar (410 Gone, 404, 401, 400) için retry yok — doğrudan throw
- 410/404 → subscription silinir (değişmedi)
- Diğer hatalar → uyarı log'lanır

---

## Fix 5 🟠 Push Notification — E2EE DM içeriği push'a sızıyordu

**Sorun:** `🔒e2e:` prefix'li şifreli mesajlar `sendPushToUser` çağrıldığında ciphertext body olarak push payload'una konulabiliyordu. Push notification içeriği işletim sistemi ve push sağlayıcı (FCM/APNS/Web Push) tarafından görülebilir — E2EE güvencesini bozardı.

**Düzeltme — `server/lib/pushSender.js`:**
- `sendPushToUser` içinde `payload.body` kontrolü eklendi
- E2EE mesajlarında body `'🔒 Şifreli mesaj'` olarak değiştirilir
- Ciphertext asla push payload'una girmez

---

## Fix 6 🟠 CI/CD — Deployment pipeline eksikti

**Sorun:** CI (test, typecheck, build) vardı ama CD yoktu. `main`'e merge olan kod elle deploy ediliyordu. `develop` branch için staging ortamı hiç yoktu.

**Düzeltme — `.github/workflows/ci.yml`:**

### Redis servisi eklendi (test job'u)
```yaml
redis:
  image: redis:7-alpine
  ports: [6379:6379]
  health-cmd: redis-cli ping
```
Test ortamına `REDIS_URL: redis://localhost:6379` eklendi — rate limit ve cache testleri artık gerçek Redis'e bağlanır.

### Job 6: `deploy-staging` (develop → staging)
- `develop` branch'e push gelince tetiklenir
- Docker image build + registry push
- SSH ile staging sunucusuna deploy
- Smoke test: `/api/health` 200 kontrolü

### Job 7: `deploy-production` (main → production)
- `main` branch'e push gelince tetiklenir
- GitHub Environment "production" → **Required reviewers** ayarlanmalı (onay mekanizması)
- Deploy öncesi mevcut image tag'i `.last_deploy_tag`'e yazar (rollback için)
- Smoke test başarısız olursa otomatik rollback: önceki image yeniden başlatılır
- Deploy özeti GitHub Actions summary'ye yazılır

**Gerekli secrets/vars (GitHub repo settings → Environments):**

| Staging | Production |
|---------|-----------|
| `STAGING_HOST` | `PROD_HOST` |
| `STAGING_USER` | `PROD_USER` |
| `STAGING_SSH_KEY` | `PROD_SSH_KEY` |
| `vars.STAGING_URL` | `vars.PRODUCTION_URL` |
| `vars.REGISTRY` | `vars.REGISTRY` |

---

## Fix 7 🟡 Push — Smoke test script eklendi

**Yeni dosya: `server/scripts/test-push.js`**

Manuel push notification testi:
```bash
DATABASE_URL=... VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... \
node server/scripts/test-push.js <userId>
```

Kullanıcının web subscription ve FCM token sayısını gösterir, gerçek push gönderir.

---

## Durum: WebAuthn ve E2EE DM

### WebAuthn ✅ Zaten çalışıyor
`setupRoutes.js` incelendiğinde `mountApi('/webauthn', webauthnRouter)` zaten mevcut. Route eksik değil.

**Yapılacak (Session 9):** `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGIN` env var'larını `.env.example`'a ekle + passkey UI login button.

### E2EE DM ✅ Server+Protocol tamamlanmış
- Server: public key API mevcut (`/api/e2e/keys`)
- Client: `client/js/core/e2e.ts` kapsamlı implementasyon mevcut
- DM handler: `🔒e2e:` prefix sistemi çalışıyor, `e2e: true` flag DB'ye yazılıyor

**Yapılacak (Session 9):** E2EE aktifken DM gönderim otomasyonu + UI kilit ikonu + "Bu konuşma uçtan uca şifreli" banner.

---

## Değişen Dosyalar

| Dosya | Değişiklik |
|-------|-----------|
| `server/socket/index.js` | `applyAdapter(io)` eklendi — Redis clustering |
| `server/middleware/rateLimit.ts` | `reconnectStrategy` fix |
| `server/lib/pushSender.js` | FCM mutex, web push retry, E2EE sanitize |
| `.github/workflows/ci.yml` | Redis servisi, staging deploy, production deploy |
| `server/scripts/test-push.js` | Yeni — push smoke test |
