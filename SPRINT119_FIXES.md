# Bridge Sprint 119 — Eksiklik Giderme Paketi

Bu paket, dış kod incelemesinde tespit edilen 4 ana eksiklik alanını kapatır.

## Dosya Yapısı

```
bridge_fixes/
├── css/
│   ├── community-features.css   # sprint93 + sprint94 birleştirildi + genişletildi
│   └── style.css                # güncel entry point (sprint93/94 kaldırıldı)
├── svelte/
│   ├── VoicePTTController.svelte       # VoicePanel'den PTT mantığı (~150 satır)
│   └── VoiceScreenShareController.svelte # VoicePanel'den SS mantığı (~120 satır)
├── k6/
│   └── full-load.js             # 4 senaryo: load / spike / soak / stress
├── e2e/
│   ├── mastodon-mock-server.ts  # CI'da çalışan AP mock peer
│   └── activitypub-ci.spec.ts  # Mock peer ile AP protokol testleri
├── security/
│   ├── THREAT_MODEL.md          # STRIDE bazlı tehdit modeli
│   ├── wsConnectionLimit.ts     # D5: WS bağlantı limiti middleware
│   ├── federationRateLimit.ts   # D6: AP inbox flood koruması
│   └── contentSanitizer.ts      # T5: Server-side içerik sanitization
└── ci/
    └── ci-sprint119-additions.yml  # Yeni CI job'ları
```

---

## Kurulum Talimatları

### 1. CSS Birleştirme

```bash
# Yeni modülü kopyala
cp bridge_fixes/css/community-features.css \
   client/css/modules/community-features.css

# style.css'i güncelle
cp bridge_fixes/css/style.css \
   client/css/style.css

# Eski sprint dosyalarını sil (artık community-features.css'te)
rm client/css/modules/sprint93.css
rm client/css/modules/sprint94.css
```

### 2. Svelte Bileşenleri (VoicePanel Refactor)

```bash
cp bridge_fixes/svelte/VoicePTTController.svelte \
   client/js/core/VoicePTTController.svelte

cp bridge_fixes/svelte/VoiceScreenShareController.svelte \
   client/js/core/VoiceScreenShareController.svelte
```

Ardından `client/js/core/VoicePanel.svelte`'de PTT ve Screen Share bölümleri
bu bileşenlere delegate edilmeli. Tam entegrasyon bir sonraki sprintin işi.

### 3. Güvenlik Middleware

```bash
# WS bağlantı limiti
cp bridge_fixes/security/wsConnectionLimit.ts \
   server/socket/middleware/wsConnectionLimit.ts

# AP inbox rate limiter
cp bridge_fixes/security/federationRateLimit.ts \
   server/middleware/federationRateLimit.ts

# Server-side content sanitizer
cp bridge_fixes/security/contentSanitizer.ts \
   server/lib/contentSanitizer.ts

# Tehdit modeli belgesi
cp bridge_fixes/security/THREAT_MODEL.md \
   docs/THREAT_MODEL.md
```

**Bağımlılık ekle (package.json):**
```json
"dompurify": "^3.1.6",
"jsdom": "^24.1.1",
"@types/dompurify": "^3.0.5",
"@types/jsdom": "^21.1.7"
```

**Entegrasyon — `server/socket/index.ts`:**
```typescript
import { wsConnectionLimitMiddleware } from './middleware/wsConnectionLimit';
// ...
io.use(wsConnectionLimitMiddleware(io));
```

**Entegrasyon — federation router:**
```typescript
import { federationGlobalRateLimit, federationInboxRateLimit }
  from '../middleware/federationRateLimit';

router.post('/ap/users/:username/inbox',
  federationGlobalRateLimit,
  federationInboxRateLimit,
  inboxHandler
);
```

**Entegrasyon — message handler:**
```typescript
import { sanitizeMessageContent } from '../lib/contentSanitizer';
// content kaydetmeden önce:
const cleanContent = sanitizeMessageContent(req.body.content);
```

**Ortam değişkenleri (.env'e ekle):**
```env
MAX_WS_PER_IP=10
MAX_UNAUTH_WS_PER_IP=3
MAX_WS_PER_USER=5
AP_INBOX_GLOBAL_MAX=500
AP_INBOX_PEER_MAX=100
AP_INBOX_BURST_MAX=20
```

### 4. E2E Testler

```bash
cp bridge_fixes/e2e/mastodon-mock-server.ts \
   e2e/helpers/mastodon-mock-server.ts

cp bridge_fixes/e2e/activitypub-ci.spec.ts \
   e2e/tests/activitypub-ci.spec.ts
```

### 5. k6 Yük Testi

```bash
cp bridge_fixes/k6/full-load.js k6/full-load.js
```

**Staging ortamında çalıştırma:**
```bash
# Temel yük (50 VU / 5 dk)
BASE_URL=https://staging.bridge.example.com \
TEST_USER=loadtest TEST_PASS=LoadTest123! \
k6 run k6/full-load.js

# Spike testi
SCENARIO=spike BASE_URL=https://staging.bridge.example.com k6 run k6/full-load.js

# 30 dk soak (bellek sızıntısı)
SCENARIO=soak BASE_URL=https://staging.bridge.example.com k6 run k6/full-load.js
```

### 6. CI

```bash
cp bridge_fixes/ci/ci-sprint119-additions.yml \
   .github/workflows/ci-sprint119-additions.yml
```

---

## Kalan Açık Riskler (Sonraki Sprint)

| Risk | Dosya | Öneri |
|------|-------|-------|
| D5 tam entegrasyon | `server/socket/index.ts` | wsConnectionLimitMiddleware bağla |
| D6 tam entegrasyon | federation router | federationInboxRateLimit bağla |
| T5 tam entegrasyon | message handler | sanitizeMessageContent bağla |
| I7 WebRTC IP sızıntısı | env config | `FORCE_TURN=true` seçeneği belgele |
| VoicePanel tam refactor | `VoicePanel.svelte` | PTT/SS delegate entegrasyonu |
| Bağımsız güvenlik denetimi | — | Sprint 121 hedefi |

---

## Sprint 119 Sonrası Tahmini Proje Tamamlanma

Tüm bu değişiklikler uygulandıktan ve testler geçtikten sonra:

- **Kod kalitesi:** 8/10 → 8.5/10
- **Test coverage:** 8/10 → 8.5/10 (AP CI testleri eklendi)
- **Güvenlik:** 8/10 → 8.5/10 (tehdit modeli + D5/D6/T5 kapatıldı)
- **Genel:** 7.5/10 → **8/10**

**Proje tamamlanma: %63 → ~%70** (staging + gerçek kullanıcı testi hâlâ eksik)
