# SPRINT72_CHANGES.md
_Tarih: 2026-05-21 | Temel: Sprint 71 (8.4/10)_

---

## Özet

Sprint 72, kod inceleme raporunun belirlediği üç öncelikli alanı kapatır:
**teknik borç / eslint temizliği**, **i18n bundle optimizasyonu** ve **client-side test coverage genişletme**.
5GB dosya limiti kasıtlı olarak korunmuştur (proje gereksinimi).

---

## 1. `server/app/createApp.ts` — Stale eslint-disable yorumları kaldırıldı

**Sorun:** Dosyanın başında `/* eslint-disable @typescript-eslint/no-var-requires */` bloğu
vardı; ancak altındaki tüm satırlar zaten `import` sözdizimi kullanıyordu — `require()` çağrısı
yoktu. Yorum hem yanıltıcıydı hem de TS geçişinin yarıda kaldığı izlenimi veriyordu.

**Yapılan:**
- Stale `eslint-disable / eslint-enable` blokları kaldırıldı.
- "CommonJS modülleri — require() ile yükleniyor" açıklaması yerine geçişi belgeleyen
  kısa bir Sprint 72 notu eklendi.

**Etki:** `createApp.ts` artık tam ESM; CI'daki `@typescript-eslint/no-var-requires`
kuralı bu dosyada false-positive üretmez.

---

## 2. `client/js/core/i18n.ts` — Lazy-load mimarisine geçiş

**Sorun:** 4 dilin (~900 satır, 45 KB) tamamı tek dosyada tanımlıydı ve
uygulama ilk yüklenirken hepsini parse ediyordu. TR dışındaki dil tablolarının
başlangıçta belleğe alınması gerekmiyordu.

**Yapılan:**

| Dosya | Açıklama |
|-------|----------|
| `client/js/core/i18n/tr.ts` | Türkçe çeviri tablosu (ayrı modül) |
| `client/js/core/i18n/en.ts` | İngilizce çeviri tablosu (ayrı modül) |
| `client/js/core/i18n/de.ts` | Almanca çeviri tablosu (ayrı modül) |
| `client/js/core/i18n/fr.ts` | Fransızca çeviri tablosu (ayrı modül) |
| `client/js/core/i18n.ts`    | Yeniden yazıldı — lazy loader + önbellek |

**Yeni mimari:**
- Uygulama açılışında yalnızca TR (varsayılan) ve kullanıcının tarayıcı dili yüklenir.
- `setLang('en')` ilk kez çağrıldığında `import('./i18n/en.js')` tetiklenir; sonraki çağrılarda önbellekten döner.
- `preloadAll()` fonksiyonu eklendi — boş zamanda tüm diller önceden yüklenebilir.
- `i18n.ready` Promise alanı eklendi — DOM manipülasyonu öncesinde dil yüklenmesini beklemek için.
- Public API (`t`, `setLang`, `lang`, `toggleLang`, `_applyAll`, BridgeRegistry kayıtları) **geriye uyumlu** kaldı.

**Tahmini bundle tasarrufu:** ~34 KB (en/de/fr tabloları initial bundle'dan çıktı).

**Breaking change:** `setLang()` artık `void` yerine `Promise<void>` döndürür.
Mevcut `onclick="i18n.setLang('en')"` kullanımları çalışmaya devam eder;
await bekleyen kodlar için tip güncellenmesi gerekebilir.

**`i18n.LANGS` değişikliği:** Eski `LANGS` nesnesi senkron tam tabloydu; yeni
`i18n.LANGS` getter'ı yüklenen dillerin önbelleğini (`_cache`) döndürür. Doğrudan
`LANGS.en['key']` erişimi kullanan varsa `t('key')` kullanımına geçmeli.

---

## 3. Client-side Vitest testleri — yeni test dosyaları

Kod inceleme raporu client testlerini (18 dosya) server testlerine (122 dosya) göre
zayıf bulmuştu ve dm-call.ts'deki 5GB bug'ının test tarafından yakalanamadığını vurgulamıştı.

### `client/tests/dm-call-filesize.test.ts` _(yeni)_

| Test grubu | Adet |
|-----------|------|
| `MAX_FILE_BYTES` sabiti doğrulama | 2 |
| Dosya türü doğrulama (IMAGE_ALLOWED) | 8 |
| Boyut sınırı (sınır değerleri) | 6 |
| Upload stratejisi seçimi | 2 |
| Hata mesajı içeriği | 1 |
| **Toplam** | **19** |

Öne çıkan test: `[REGRESSION] 5GB dosya reddedilmeli` — bu test Sprint 71'de yoktu,
dolayısıyla 5GB bug'ı kaçmıştı. Artık limit ne olursa olsun sınır değerleri test edilmektedir.

### `client/tests/voice-recorder-unit.test.ts` _(yeni)_

| Test grubu | Adet |
|-----------|------|
| Başlangıç durumu | 4 |
| Default değerler | 5 |
| `_bestMimeType()` | 2 |
| `getUploadExt()` | 3 |
| `start()` | 5 |
| `stop()` | 2 |
| `cancel()` | 4 |
| `elapsed()` | 2 |
| Upload tamamlama | 2 |
| **Toplam** | **29** |

MediaRecorder, MediaStream ve MediaStreamTrack mock'ları sıfırdan yazıldı —
jsdom'da bu API'ler bulunmadığından izole test için zorunluydu.

### `client/tests/messages-input-unit.test.ts` _(yeni)_

| Test grubu | Adet |
|-----------|------|
| `formatText()` — temel dönüşümler | 5 |
| `formatText()` — markdown | 6 |
| `formatText()` — kod blokları | 4 |
| `formatText()` — mention & newline | 4 |
| `formatText()` — XSS vektörleri | 3 |
| `validateSendMessage()` — limit & tür | 10 |
| `handleMsgKey()` — klavye mantığı | 5 |
| `calcTextareaHeight()` | 6 |
| `cancelEdit` mantığı | 2 |
| `showDeleteMessageModal` | 1 |
| Slash command tespiti | 5 |
| **Toplam** | **51** |

`formatText()` XSS testleri özellikle önemlidir: `<script>`, `onerror` ve
`javascript:` vektörlerinin escape edildiğini doğrular.

---

## Dosya Değişim Özeti

| Dosya | Durum | Açıklama |
|-------|-------|----------|
| `server/app/createApp.ts` | Değiştirildi | Stale eslint-disable kaldırıldı |
| `client/js/core/i18n.ts` | Yeniden yazıldı | Lazy-load mimarisi |
| `client/js/core/i18n/tr.ts` | Yeni | TR çeviri tablosu |
| `client/js/core/i18n/en.ts` | Yeni | EN çeviri tablosu |
| `client/js/core/i18n/de.ts` | Yeni | DE çeviri tablosu |
| `client/js/core/i18n/fr.ts` | Yeni | FR çeviri tablosu |
| `client/tests/dm-call-filesize.test.ts` | Yeni | 19 test |
| `client/tests/voice-recorder-unit.test.ts` | Yeni | 29 test |
| `client/tests/messages-input-unit.test.ts` | Yeni | 51 test |

---

## Sprint 72 Sonrası Açık Maddeler

Kod inceleme raporunun en önemli önerisi olan **medya depolama** (S3/R2/MinIO)
bu sprint'e alınmadı — altyapı değişikliği gerektiriyor ve ayrı bir sprint olarak
planlanması önerilir.

Bunun yanı sıra:
- Canary/blue-green deployment stratejisi hâlâ yok.
- DEPLOYMENT_GUIDE.md'de rate limit auto-ban dokümantasyonu eksik.
- Swagger `/docs` route'unun aktif olup olmadığı doğrulanmadı.
- Monorepo tooling (Turborepo/Nx) değerlendirilmedi.
