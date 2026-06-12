# Bridge — Production Hazırlık Durumu

Bu belge, kod tabanının teknik tamamlanma durumu ile gerçek bir üretim ürünü olarak hazır olma durumu arasındaki farkı açıkça ortaya koyar.

---

## Kod Tabanı vs Ürün Ayrımı

| Boyut | Durum | Notlar |
|-------|-------|--------|
| Kaynak kod tamlığı | ✅ ~%85 | Tüm temel özellikler implement edilmiş |
| Test coverage | ✅ Yüksek | Server %90 line, E2E 27 spec |
| Deployment altyapısı | ✅ Tam | Docker, K8s, Helm, CI/CD |
| Güvenlik mekanizmaları | ✅ İyi | E2EE, JWT, WebAuthn, rate limiting |
| Dokümantasyon | ✅ Kapsamlı | README, OpenAPI, ADR'ler |
| **Production yükü** | ⚠️ Test edilmedi | Yalnızca CI ortamında, 5 VU, localhost |
| **Gerçek kullanıcı geri bildirimi** | ❌ Yok | Hiç son kullanıcı deneyimi geçirmemiş |
| **ActivityPub interop** | ⚠️ Kısmi | E2E testleri local mock; Mastodon.social ile gerçek interop doğrulanmamış |
| **Mediasoup production ölçeği** | ⚠️ Test edilmedi | Tek sunucu testi var; çoklu katılımcı ölçeği bilinmiyor |
| **App Store varlığı** | ❌ Yok | Pipeline hazır; yayınlanmış uygulama yok |
| **Sürdürülebilirlik** | 🔮 Belirsiz | Bağış modeli tanımlanmış; gerçek gelir yok |

**Sonuç:** Bu bir "hazır codebase"dir — "hazır ürün" değil.

---

## Performans Baseline Uyarısı

`k6/results/baseline-summary.json` içindeki metrikler (**p95=61ms, hata=%0**) aşağıdaki koşullarda alınmıştır:

- **Ortam:** GitHub Actions CI runner (ubuntu-latest)
- **Hedef:** localhost:3001
- **VU:** 5 sanal kullanıcı
- **Süre:** 60 saniye

Bu değerler gerçek bir production ortamını temsil etmez. Gerçekçi bir yük testi için:

```bash
# Staging ortamında gerçek yük testi
BASE_URL=https://staging.bridge.example.com k6 run k6/load-realistic.js

# Spike testi
BASE_URL=https://staging.bridge.example.com SCENARIO=spike k6 run k6/load-realistic.js

# 30 dakika soak testi
BASE_URL=https://staging.bridge.example.com SCENARIO=soak k6 run k6/load-realistic.js
```

Gerçek production baseline için `k6/load-realistic.js` sonuçlarını `k6/results/` klasörüne ekleyin.

---

## ActivityPub / Mastodon Interop Durumu

`e2e/tests/mastodon-activitypub.spec.ts` içindeki testler:

- `MASTODON_URL` ve `MASTODON_TOKEN` env değişkenleri olmadan **atlanır**
- CI pipeline'da bu değişkenler **tanımlı değildir** — testler CI'da koşmaz
- Gerçek interop için manuel test yapılması gerekir:

```bash
MASTODON_URL=https://mastodon.social \
MASTODON_TOKEN=<gerçek_token> \
BRIDGE_URL=https://staging.bridge.example.com \
npx playwright test e2e/tests/mastodon-activitypub.spec.ts
```

**Bilinen durum:** ActivityPub protokol implementasyonu (WebFinger, NodeInfo, inbox/outbox) kod olarak tamamdır. Gerçek bir Mastodon instance ile uçtan uca testi yapılmamıştır.

---

## Mediasoup SFU Production Ölçeği

Mevcut testler:
- `server/tests/socket-room-leak.test.ts` — bellek sızıntısı testi (unit)
- `k6/mediasoup-sfu-load.js` — yük testi scripti (çalıştırılmamış)
- `k6/websocket-cluster-test.js` — cluster WebSocket testi

**Doğrulanmamış alanlar:**
- 100+ eş zamanlı ses/video katılımcısı
- Birden fazla SFU worker ile yük dağılımı
- Uzun süreli oturum (> 2 saat) kararlılığı

---

## Önce Bunları Yapın (Production'a Geçmeden)

### 1. Gerçek Staging Ortamı Kurun
```bash
# Docker Compose ile staging
cp .env.example .env
# Gerçek değerleri doldurun
docker compose up -d
```

### 2. Yük Testini Gerçek Ortamda Çalıştırın
```bash
BASE_URL=https://staging.bridge.example.com k6 run k6/load-realistic.js
```

### 3. ActivityPub Interop'u Doğrulayın
Bir Mastodon test hesabı alın ve `mastodon-activitypub.spec.ts`'i gerçek ortamda çalıştırın.

### 4. Mediasoup SFU Yük Testini Tamamlayın
```bash
BASE_URL=https://staging.bridge.example.com k6 run k6/mediasoup-sfu-load.js
```

### 5. Güvenlik Denetimi
Açık kaynak topluluktan bağımsız güvenlik değerlendirmesi isteyin veya bir pentest gerçekleştirin.

---

*Bu belge Sprint 119'da dış kod incelemesi bulgularına dayanarak oluşturulmuştur.*
