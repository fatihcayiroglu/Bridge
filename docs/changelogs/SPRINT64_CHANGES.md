# Sprint 64 — Değişiklik Günlüğü

**Tarih:** 2026-05-20
**Kapsam:** 9 madde (3 yüksek öncelik, 3 orta, 3 düşük)

---

## 🔴 Yüksek Öncelik

### 1. Swagger CI Düzeltmesi (`scripts/check-swagger-coverage.ts`)

**Sorun:** Script `process.cwd()` tabanlı path kullanıyordu. CI `working-directory: server`
altında çalıştığında `ROUTES_DIR` → `server/server/routes` oluyor ve sıfır dosya
bulunuyordu; gerçek kapsam %0 olarak raporlanıp CI bloklanıyordu.

**Düzeltme:** `path.join(process.cwd(), 'scripts')` → `path.resolve(__dirname)`.
`__dirname` her zaman script'in gerçek dizinine (`scripts/`) çözülür.

**Etki:** CI Swagger coverage adımı artık doğru çalışır. Gerçek kapsam %100.

---

### 2. Kullanıcı Onboarding Wizard'ı

**Yeni dosyalar:**
- `client/js/core/onboarding-wizard.ts` — Wizard modülü
- `client/js/app.ts` — `bridge:auth-success` event hook'u

**Özellikler:**
- 8 adımlı, i18n destekli (TR/EN/DE/FR) wizard
- `localStorage` flag ile yalnızca ilk girişte gösterilir (`STORAGE_VER='2'`)
- Tam klavye navigasyonu (ArrowLeft/Right, Esc, Tab focus trap)
- WCAG 2.1 uyumlu: `role="dialog"`, `aria-modal`, `aria-label`
- Tanıtılan özellikler: E2E, Federation, Bot Marketi, Sesli Mesaj,
  Gelişmiş Arama, AI Özet, Klavye Kısayolları
- `resetOnboarding()` ile test/debug sıfırlaması
- BridgeRegistry'e kayıtlı

---

### 3. i18n — EN/DE/FR Tamamlandı

**Değiştirilen dosya:** `client/js/core/i18n.ts`

| Dil | Önceki | Sonraki | Eklenen |
|-----|--------|---------|---------|
| EN  | 153/158 (%97) | 158/158 (%100) | 10 anahtar |
| DE  | 70/158  (%44) | 158/158 (%100) | 89 anahtar |
| FR  | 59/158  (%37) | 158/158 (%100) | 100 anahtar |

Eklenen kategoriler:
- Hata mesajları (`error_forbidden`, `error_ratelimit`, `error_server`, …)
- Tooltip etiketleri (`tip_audio_call`, `tip_compact`, `tip_video_call`, …)
- Bildirim metinleri (`notif_mention`, `notif_reply`, …)
- Kanal tipleri (`channel_text`, `channel_voice`, `channel_stage`, …)
- Kalite seçenekleri (`quality_hd`, `quality_balanced`, …)
- Tüm onboarding wizard anahtarları (her 4 dil için)

---

## 🟡 Orta Öncelik

### 4. A11Y E2E Kapsamı Genişletildi

**Yeni dosya:** `e2e/tests/a11y.flows.spec.ts`

Eklenen test senaryoları (axe-core + Playwright):

| Test | Kapsam |
|------|--------|
| DM listesi — ARIA listbox & keyboard | `[role="listbox"]` navigasyonu |
| DM penceresi — landmark & mesaj kutusu ARIA | `role="textbox"` doğrulaması |
| Kanal listesi — Tab/Arrow navigasyonu | Focus indicator görünürlüğü |
| Kanal geçişi sonrası — mesaj alanı | axe WCAG2A/AA tarama |
| Kanal ayarları modalı — focus trap & Esc | `aria-modal`, focus trap, Esc kapama |
| Sunucu ayarları modalı | axe tarama |
| Üye listesi — ARIA rolleri | `role="option"/"listitem"` doğrulaması |
| Emoji picker — klavye & ARIA grid | Tab navigasyonu, Esc kapama |
| Bildirim alanı — `role="status"` | `aria-live` kontrolü |
| Yüksek kontrast modu | `forcedColors: active` emülasyon |

---

### 5. Client Test Coverage Eşikleri

**Değiştirilen dosya:** `server/package.json` (`jest.coverageThreshold`)

Sprint 42'de ertelenen modüller için eşikler tanımlandı:

| Dosya | lines | functions | branches |
|-------|-------|-----------|---------|
| `routes/discover.ts` | 70 | 65 | 60 |
| `routes/semantic.ts` | 70 | 65 | 60 |
| `socket/handlers/discover.ts` | 65 | 60 | 55 |
| `routes/bots.ts` | 70 | 65 | 60 |
| `routes/music.ts` | 75 | 70 | 65 |
| `routes/channelPerms/helpers.ts` | 72 | 68 | 62 |

Not: Global eşik `lines: 75` korundu. Yeni eşikler mevcut duruma göre
kademeli hedefler; her sprint 2–3 puan artırılması planlanıyor.

---

### 6. API Hata Toast Standardizasyonu

**Yeni dosya:** `client/js/core/api-error-toast.ts`

- `handleApiError(input, opts?)` — tek giriş noktası
- HTTP status → i18n key eşlemesi (400/401/403/404/413/429/500/502/503)
- Ağ hatası (`Failed to fetch`, `AbortError`) için özel mesaj
- Rate limit (429) ve auth (401/403) hataları → `'warning'` severity
- Kısa yollar: `toastForbidden()`, `toastRateLimit()`, `toastNetworkError()`, `toastSuccess()`
- `report: true` ile `errorBoundary.report()` entegrasyonu

**Kullanım:**
```typescript
import { handleApiError } from './api-error-toast.js';

try {
  const res = await apiFetch('/api/servers', { method: 'POST', body });
  if (!res.ok) { handleApiError(res); return; }
} catch (err) {
  handleApiError(err);
}
```

---

## 🟢 Düşük Öncelik

### 7. Plugin Ekosistemi Moderasyon Stratejisi

**Yeni dosya:** `PLUGIN_MODERATION.md`

İçerik:
- 3 katmanlı yayınlanma yolu (teknik → küratör → topluluk)
- Bot manifest izin modeli ve yasaklı izinler
- İçerik kuralları (yasak / kısıtlı kategoriler)
- `plugins/allowlist.ts` genişletme önerileri (manifest validation)
- Küratör rol yapısı ve SLA'lar
- Kaldırma süreci (rapor → inceleme → escalation)
- Roadmap (Sprint 65–67+ hedefleri)

---

### 8. Mobil Native Push Belgelendirmesi

**Yeni dosya:** `mobile/NATIVE_PUSH_SETUP.md`

- iOS APNs (p8 yöntemi) adım adım kurulum
- Android FCM v1 kurulumu
- Firebase Console yapılandırması
- `google-services.json` ve `GoogleService-Info.plist` kurulum yerleri
- iOS Simulator push test komutu (`xcrun simctl push`)
- Bilinen sorunlar & Sprint 65 hedefleri (APNs/FCM v1 gerçek entegrasyon)

**Güncellenen dosya:** `.env.example`
- `APNS_KEY_PATH`, `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_BUNDLE_ID`, `APNS_ENV`
- `FCM_SERVICE_ACCOUNT_PATH`, `FCM_PROJECT_ID`
- `NATIVE_PUSH_ENABLED`, `NATIVE_PUSH_BADGE_RESET`

---

### 9. CDN/Medya Deployment Rehberi Tamamlandı

**Güncellenen dosya:** `DEPLOYMENT_GUIDE.md`

Yeni bölüm: **CDN & Medya Depolama**

| Backend | Kapsam |
|---------|--------|
| `local` (varsayılan) | Kısa açıklama, avantaj/dezavantaj |
| Cloudflare R2 | Bucket oluşturma, API token, CORS, custom domain, .env |
| MinIO (self-hosted) | Docker Compose servisi, mc ile bucket kurma, nginx proxy |
| AWS S3 | IAM policy, CloudFront entegrasyonu |
| Geçiş rehberi | `local → cloud` — mc mirror komutu |
| Güvenlik kontrol listesi | CDN'e özgü 7 madde |

---

## Değişen Dosyalar (Özet)

| Dosya | Tip | Açıklama |
|-------|-----|---------|
| `scripts/check-swagger-coverage.ts` | Düzeltme | `__dirname` path fix |
| `client/js/core/onboarding-wizard.ts` | YENİ | Kullanıcı wizard'ı |
| `client/js/app.ts` | Güncelleme | Wizard hook + import |
| `client/js/core/i18n.ts` | Güncelleme | EN+10, DE+89, FR+100 çeviri |
| `client/js/core/api-error-toast.ts` | YENİ | Standart hata toast |
| `e2e/tests/a11y.flows.spec.ts` | YENİ | A11Y E2E testleri |
| `server/package.json` | Güncelleme | 6 yeni coverage threshold |
| `PLUGIN_MODERATION.md` | YENİ | Plugin moderasyon stratejisi |
| `mobile/NATIVE_PUSH_SETUP.md` | YENİ | Native push kurulum rehberi |
| `.env.example` | Güncelleme | Native push değişkenleri |
| `DEPLOYMENT_GUIDE.md` | Güncelleme | CDN bölümü |
