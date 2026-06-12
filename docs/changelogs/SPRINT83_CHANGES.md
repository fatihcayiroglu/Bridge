# Sprint 83 — Değişiklik Notları

**Tarih:** 24 Mayıs 2026
**Önceki Sprint:** Sprint 82 (Activities iskelet, Super Reactions, Clips, Stickers, i18n +5 dil)

---

## Sprint 82'den Kalan Eksikliklerin Tamamlanması

### 1. Activities — Watch Together (Gerçek Implementasyon) ✅

**Dosya:** `client/activities/watch-together/index.html`

- YouTube IFrame API ile tam entegrasyon
- Video ID çıkarma (youtube.com/watch, youtu.be, shorts, embed URL formatları)
- Oynat / Duraklat / Senkronize Et / Video Değiştir kontrolleri
- Katılımcı sidebar (isim, avatar, host badge)
- `postMessage` ile parent frame ↔ aktivite iframe çift yönlü iletişim:
  - `watch-together:ready`, `watch-together:load`, `watch-together:play`, `watch-together:pause`, `watch-together:sync-request`
- oEmbed ile video başlığı otomatik çekme
- Tam responsive layout (sidebar + video area)

### 2. Activities — Chess Engine (Gerçek Implementasyon) ✅

**Dosya:** `client/activities/chess/index.html`

- Sıfırdan yazılmış tam satranç motoru (harici kütüphane yok):
  - Tüm taş hareketleri (piyon çift adım, at atlama, fil/kale/vezir kayma, şah)
  - Yasal hamle filtreleme (şah altında kalma engeli)
  - Şah mat + pat tespiti
  - Piyon terfi (otomatik vezire)
- Visual board: aydınlık/karanlık kareler, seçili hücre, geçerli hamle noktaları, yakalama vurgusu, son hamle rengi
- Konuşmacı sırası göstergesi, hamle geçmişi (algebraic notation)
- Yakalanan taşlar gösterimi
- **Bot modu:** rastgele yasal hamle + yakalama tercihi
- **Multiplayer modu:** `postMessage` ile hamle senkronizasyonu (2 oyuncu)
- Tam responsive layout (board + info panel)

### 3. Sticker Görselleri (SVG Asset'ler) ✅

**Dizin:** `client/assets/stickers/`

**Bridge Classic paketi** (8 sticker):
`wave`, `heart`, `fire`, `cool`, `bridge_logo`, `thumbsup`, `party`, `rocket`

**Meme Collection paketi** (4 sticker):
`pepe_wave`, `kek`, `this_is_fine`, `nerd`

**Aktivite ikonları** (6 SVG):
`watch-together`, `chess`, `draw-together`, `word`, `trivia`, `default`

Tüm SVG'ler 100×100 viewBox, emoji + renk temelli, animasyon eklemeye hazır.

### 4. i18n — Rusça Tamamlandı ✅

**Dosya:** `client/js/core/i18n/ru.ts`

- Önceki durum: 78 key (EN'e göre 92 eksik)
- Yeni durum: **182 key** — EN ile tam pariteye ulaştı
- Eklenen başlıca anahtarlar: tüm `tip_*` tooltip'ler, `screen_loading`, `error_*` hata mesajları, moderasyon terimleri, kanal türleri, onboarding adımları

### 5. Bot Marketplace Server-Side Catalog API ✅

**Dosya:** `server/routes/bot-marketplace.ts`
**Route:** `GET|POST|PATCH|DELETE /api/bots/marketplace`

| Method | Path | Açıklama |
|---|---|---|
| GET | `/api/bots/marketplace` | Approved botları listele (filtre: category, featured, q, limit, offset) |
| GET | `/api/bots/marketplace/:botId` | Tek bot detayı |
| POST | `/api/bots/marketplace` | Bot gönder (admin onayı bekler) |
| PATCH | `/api/bots/marketplace/:botId` | Admin: güncelle + onayla + featured yap |
| DELETE | `/api/bots/marketplace/:botId` | Admin: kaldır |

- Client `bot-catalog.ts` zaten `/api/bots/marketplace?limit=100` çekiyordu; artık gerçek endpoint var
- Static `catalog-data.ts` fallback olarak kalır (offline/hata durumu)
- Seed data: 5 featured bot (Bridge Music, Bridge Guard, Bridge AI, Welcome Pro, Game Night)
- `setupRoutes.ts`'e mount edildi

### 6. Stage Kanal Video Grid Layout ✅

**Dosya:** `client/js/core/stage-video-grid.ts`

- Dinamik grid hesaplama: 1 kişi = tam ekran, 2 = yan yana, 3-4 = 2×2, 5-9 = 3×3, 10+ = 4×4
- WebRTC stream bağlama: `video.srcObject = stream` (flicker önleyici DOM diff)
- Kamera yok → avatar tile (isim baş harfi + renk)
- Konuşma göstergesi: yeşil `outline` animasyonu
- Kamera aç/kapat: `toggleLocalVideo()` → `getUserMedia` + socket `stage:video-on/off`
- Self-mute (echo önleme)
- `app.ts`'e `initStageVideoGrid()` eklendi

### 7. Kubernetes Manifests ✅

**Dizin:** `k8s/`

| Dosya | İçerik |
|---|---|
| `namespace.yaml` | `bridge` namespace |
| `configmap.yaml` | Ortam değişkenleri |
| `secret.yaml` | Gizli değer şablonu (git'e commit edilmez) |
| `postgres.yaml` | PostgreSQL 16 StatefulSet + headless Service + PVC 20Gi |
| `redis.yaml` | Redis 7 Deployment + Service + maxmemory 256MB |
| `bridge.yaml` | App Deployment (replicas:2, RollingUpdate) + ClusterIP Service |
| `ingress.yaml` | nginx Ingress (WebSocket desteği, TLS-ready) |
| `hpa.yaml` | HPA: CPU %70 / Memory %80 → 2–10 replica |
| `pdb.yaml` | PodDisruptionBudget: minAvailable=1 |
| `kustomization.yaml` | `kubectl apply -k k8s/` ile tek komut deploy |

---

## Kalan Açık Maddeler (Sprint 84 için)

| Madde | Öncelik |
|---|---|
| Draw Together aktivitesi (canvas + WebSocket sync) | Yüksek |
| Word Snack + Trivia aktiviteleri | Orta |
| Bot marketplace admin UI (onay kuyruğu) | Orta |
| Sticker animasyonu (CSS/GSAP) | Düşük |
| Mobile (Capacitor) native kamera entegrasyonu | Orta |
| i18n: İtalyanca, Çince, Arapça, Flemenkçe | Düşük |
| Stage video grid: WebRTC P2P stream bağlama (SFU üzerinden) | Yüksek |

---

## Dosya Sayısı Özeti

| Kategori | Eklenen |
|---|---|
| Activity HTML sayfaları | 2 |
| SVG asset'ler | 18 |
| TypeScript modülleri | 2 |
| Server route'ları | 1 |
| Kubernetes YAML | 10 |
| i18n güncelleme | 1 (ru.ts) |
| Toplam | **34 dosya** |
