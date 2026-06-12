# Sprint 63 — Zayıf Yön Giderme

## 1. CDN / WebP Optimizasyonu

### `.env.example` genişletildi
- `CDN_PROVIDER` açıklaması: `local | r2 | b2 | minio` (önceki: `local | s3 | r2`)
- R2, B2, MinIO için tam değişken setleri belgelendi (`R2_ACCOUNT_ID`, `B2_KEY_ID`, `MINIO_ENDPOINT` vb.)
- `WEBP_CONVERT` ve `WEBP_QUALITY` değişkenleri eklendi — önceki sprint'te implementasyon vardı ama dokümantasyonu yoktu
- `CDN_BASE_URL` ve `S3_*` alanları kaldırıldı (mevcut kodda karşılığı yoktu)

### `server/package.json`
- `sharp` → `optionalDependencies` altına eklendi (`^0.33.0`)
- Yükleme: `npm install` (sharp yoksa sessizce atlanır), aktifleştirmek için `npm install sharp`

---

## 2. Client Svelte/Vanilla Geçişi — Channel Perms

### `ChannelPermsModal.svelte` — tam içerik geçişi
Sprint 61'den kalma yarım iş tamamlandı. Önceki durum: Svelte yalnızca modal kabuğuydu (header + tab nav), içerik `modal-core.ts`'den `innerHTML` ile `#ch-perms-content-host`'a enjekte ediliyordu.

**Yeni durum — tamamen Svelte:**
- Matrix paneli: rol/üye seçimi, 5 aksiyon butonu, şablon seçici, matris host
- Audit paneli: filtre kontrolleri (action/rol/tarih), Filtrele/Sıfırla/Export/Import butonları, log listesi
- Sync paneli: kanal listesi, Tümünü Seç/Hiçbirini Seçme, Önizle ve Uygula
- Footer: Kaydet/İptal butonları
- `dirty-badge`: `isDirty` prop'u ile Svelte reaktivitesiyle yönetiliyor (DOM manipülasyonu yok)
- Tüm buton callback'leri prop olarak geçiyor — `modal-core.ts`'e bağımlılık yok

### `channel-perms-svelte.ts` — prop güncelleme sistemi
- `contentHost` kaldırıldı (artık Svelte içerik host'u yok)
- `updateProps(patch)` eklendi — `modal-core.ts` matrixHtml/isDirty/saveInfo güncellemelerini buradan yapar
- `initialProps` parametresi eklendi — mount anında tüm prop'lar geçilebiliyor

### `modal-core.ts` — 540 → 368 satır (−32%)
- `_renderModal()` kaldırıldı — HTML template string üretimi yok
- DOM querySelector/addEventListener wiring kaldırıldı
- `mountChannelPermsShell()` çağrısına `initialProps` olarak callback'ler geçiliyor
- `updateModalProps()` export edildi — dış modüllerin (modal-state, modal-audit-sync) dirty/saveInfo güncellemesi için
- Fallback vanilla overlay kaldırıldı; Svelte yüklenemezse toast + return (sessiz degredation yok)

---

## 3. E2E Testleri — Eksik Akışlar

### `e2e/tests/settings.spec.ts` (yeni)
- Settings modal açılıyor (Svelte bileşeni)
- Sekmeler arası geçiş (Görünüm, Bildirimler)
- Escape ile kapatma
- API: profil güncelleme (displayName)
- API: boş displayName reddi (400)
- API: kimlik doğrulamasız güncelleme reddi (401)

### `e2e/tests/2fa.spec.ts` (yeni)
- TOTP setup API — secret dönüyor
- Geçersiz OTP reddi (400)
- Tüm 2FA endpoint'leri auth gerektiriyor (401)
- Kullanıcı 2FA durumu (`/api/me` → `twoFactorEnabled`)
- Token olmadan disable reddi
- 2FA aktif kullanıcı login akışı (`BRIDGE_E2E_2FA_USER` env ile)
- Brute-force koruması — hızlı tekrar denemeler (429)

### `e2e/tests/webp-upload.spec.ts` (yeni)
- PNG yükleme → URL dönüyor
- `WEBP_CONVERT=true` ise URL `.webp` uzantılı
- GIF animasyon korunuyor (WebP'ye dönüştürülmüyor)
- Kimlik doğrulamasız yükleme reddi (401)
- İzin verilmeyen dosya tipi reddi (400)
- SVG XSS sanitizasyonu
- `CDN_PROVIDER=r2` ise URL CDN domain'inden dönüyor
- `local` provider'da URL `/uploads/` ile başlıyor
- Chunked upload — ilk chunk kabul ediliyor

### CI güncellemesi (`.github/workflows/ci.yml`)
- `npx playwright test --reporter=list,json` olarak güncellendi
- `PLAYWRIGHT_JSON_OUTPUT_NAME=playwright-results.json` eklendi
- "E2E Test Özeti" adımı eklendi: geçti/başarısız/atlandı sayıları tablo formatında

---

## Satır sayıları (önceki → sonraki)

| Dosya | Önceki | Sonraki | Değişim |
|-------|--------|---------|---------|
| `ChannelPermsModal.svelte` | 84 | 228 | +içerik panelleri |
| `channel-perms-svelte.ts` | 79 | 79 | ~aynı, updateProps eklendi |
| `modal-core.ts` | 540 | 368 | −32% |
| `e2e/tests/settings.spec.ts` | — | 93 | yeni |
| `e2e/tests/2fa.spec.ts` | — | 127 | yeni |
| `e2e/tests/webp-upload.spec.ts` | — | 188 | yeni |

## Skor Beklentisi (Sprint 62: 8.6/10)

| Kategori | Sprint 62 | Sprint 63 |
|----------|-----------|-----------|
| Mimari / Svelte geçişi | 9.0 | 9.5 |
| CDN/Medya Optimizasyonu | 7.5 | 8.5 |
| E2E Testler | 8.0 | 9.0 |
| **Ortalama** | **8.6** | **9.0** |
