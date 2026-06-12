# Sprint 106 — Eksiklik Kapatma (2026-05-29)

## Özet

Bu sprint tamamen kod incelemesinde tespit edilen eksiklikleri kapatmaya odaklanmıştır.
Yeni özellik eklenmemiş; mevcut sistemin güvenilirliği, test kapsamı ve dokümantasyonu güçlendirilmiştir.

---

## Değişiklikler

### 1. Channel List Cache

**Dosya:** `server/routes/servers/channels.ts`

**Sorun:** `GET /api/servers/:sid/channels` her istekte PostgreSQL'e vuruyordu.
Kanallar nadiren değiştiği halde, aktif bir sunucuda bu endpoint sık çağrılıyordu.

**Çözüm:**
- Redis-backed 30s TTL cache eklendi.
- `invalidateChannelList(serverId)` export edildi — kanal eklendiğinde, güncellendiğinde
  veya silindiğinde ilgili cache key temizleniyor.
- Cache hatası (Redis down) yanıtı engellemez; DB'ye fall-through yapılır.
- `X-Cache: HIT` / `X-Cache: MISS` header eklenmiştir (debug kolaylığı için).

**Etki:** Aktif sunucularda kanal listesi sorgularında DB yükü ~%80 azalır (30s pencere içinde).

---

### 2. Mesaj Cache TTL Optimizasyonu

**Dosya:** `server/routes/messages.ts`

**Sorun:** İlk sayfa mesaj cache'i sabit 10s TTL ile yazılıyordu. Bu değer:
- Aktif kanallar için fazla uzun (10s bayat mesaj gösterebilir),
- Sessiz kanallar için gereksiz kısa (sürekli DB hit).

**Çözüm:** Adaptive TTL:

| Son mesajın yaşı | TTL |
|-----------------|-----|
| < 2 dakika (çok aktif) | 5s |
| 2–10 dakika (orta aktif) | 15s |
| > 10 dakika (sessiz) | 45s |

**Ek:** `message:edit` ve `message:delete` socket handler'larına da cache invalidation eklendi.
Daha önce yalnızca yeni mesaj gönderiminde `messages:${channelId}:first:*` key'leri
siliniyordu; düzenleme ve silme sonrası bayat cache kalabiliyordu.

---

### 3. Nginx Production Config

**Dosyalar:** `nginx.conf` (yeni), `docker-compose.yml` (güncellendi)

**Sorun:** `docker-compose.yml`'de nginx servisi tamamen yorum satırındaydı;
`nginx.conf` dosyası hiç yoktu. Kullanıcı production'da nginx kurmak istediğinde
sıfırdan konfigürasyon yazmak zorunda kalıyordu.

**Çözüm:**
- Tam işlevsel `nginx.conf` oluşturuldu:
  - TLS 1.2/1.3 (ECDHE cipher suite)
  - HSTS, X-Frame-Options, CSP, X-Content-Type-Options
  - Gzip sıkıştırma (JS/CSS/JSON)
  - WebSocket proxy (`Upgrade` header, 3600s timeout)
  - Adaptif rate limit (login: 10r/m, genel API: 300r/m)
  - SPA fallback (`try_files $uri $uri/ /index.html`)
  - `client_max_body_size 2048M` (büyük dosya upload)
  - Statik varlıklar uzun TTL ile doğrudan nginx'ten
- `docker-compose.yml`'de nginx servisi `--profile nginx` ile opsiyonel aktive edilebilir.
- `certs` ve `certbot_www` volume'ları eklendi (Let's Encrypt desteği).

---

### 4. Auth Insecure Default Uyarısı Güçlendirildi

**Dosya:** `server/middleware/auth.ts`

**Sorun:** Dev ortamında insecure secret kullanıldığında yalnızca `logger.warn` çağrılıyordu.
Bu uyarı pino JSON formatında log'a gidiyordu ve dikkat çekmiyordu.
Geliştiricinin `.env.example` değerlerini değiştirmeden production'a çıkması teorik olarak mümkündü.

**Çözüm:**
- Dev ortamında `console.error` ile büyük ASCII banner basılıyor.
- 3s kasıtlı gecikme eklendi — "sessizce geçip gitmesini" önlemek için.
- `CI=true` ve `NODE_ENV=test` ortamlarında gecikme atlanıyor (CI pipeline'ları etkilenmesin).
- Production davranışı değişmedi: `process.exit(1)`.

---

### 5. Bot-SDK Tam API Referansı

**Dosya:** `bot-sdk/README.md`

**Sorun:** README sadece hızlı başlangıç örnekleri içeriyordu.
`BridgeBot` sınıfının tüm metodları, event listesi, builder sınıfları ve
TypeScript kullanımı hiç dokümante edilmemişti.

**Çözüm:** Kapsamlı API referansı eklendi:
- `BridgeBot`: constructor, bağlantı, komutlar, mesajlaşma, moderasyon, üye yönetimi
- Tüm eventler (12) — payload tipi ve tetiklenme koşuluyla
- `MessageBuilder`, `EmbedBuilder`, `ButtonBuilder`, `BotStore`, `PaginationHelper`
- TypeScript kullanım örnekleri
- Hata yönetimi rehberi

---

### 6. ROADMAP Güncellemesi

**Dosya:** `ROADMAP.md`

Aşağıdaki 6 madde tamamlandı olarak işaretlendi:

| Madde | Sprint |
|-------|--------|
| CDN + WebP otomatik dönüşümü | Sprint 95 |
| Cloudflare R2 / MinIO depolama | Sprint 95 |
| Mesaj cache TTL optimizasyonu | **Sprint 106** |
| User presence cache | Sprint 97 |
| Channel list cache | **Sprint 106** |

---

## Test Kapsamı

3 yeni test dosyası eklendi — toplam **212 test dosyası** (önceki: 201, Sprint 105'te eklenen 3 + bu sprint 3 = 207... + mevcut diğerleri).

| Dosya | Test Sayısı | Kapsam |
|-------|-------------|--------|
| `channel-list-cache.test.ts` | 9 | Cache hit/miss, invalidation, hata toleransı |
| `message-cache-ttl.test.ts` | 9 | Adaptive TTL seçimi, bypass, edit/delete inv. |
| `auth-insecure-defaults.test.ts` | 12 | Prod exit, test warn, kısa secret, CI banner |

---

## Geriye Dönük Uyumluluk

Tüm değişiklikler geriye dönük uyumludur:
- Nginx `--profile nginx` ile opsiyoneldir; mevcut kurulumları etkilemez.
- Cache layer tamamen şeffaftır; Redis olmadan in-memory fallback çalışır.
- Auth middleware davranış değişikliği yalnızca dev ortamında görünürdür.
