# Sprint 85 — Değişiklik Notları

## Özet
Sprint 84'ten ertelenen 4 altyapı/tasarım maddesi tamamlandı.
Sprint 85 fix'leri (review bulguları) da bu sürüme dahil edildi.

---

## 1. Arapça RTL Desteği

### `client/js/core/i18n.ts`
- `export const RTL_LANGS` sabiti eklendi (`Set<LangCode>` — şimdilik `'ar'`).
- `setLang()` artık RTL dillerinde `<html dir="rtl" class="rtl">`, diğerlerinde `dir="ltr" class="ltr"` set ediyor.
- Sayfa yüklendiğinde `localStorage`'dan gelen dil RTL ise başlangıç yönü de doğru uygulanıyor.

### `client/css/modules/rtl.css` _(yeni)_
- Sidebar, mesaj listesi, input bar, dropdown, modal, tooltip, arama, ayarlar sekmeleri için RTL override'ları.
- Yön bildiren SVG ikonlar `.icon-directional` sınıfıyla `scaleX(-1)` mirror'ı.
- CSS custom property `--inline-start / --inline-end` — ileride logical properties geçişine hazır.

---

## 2. Chess Sunucu Tarafı Doğrulama

### `server/socket/handlers/activities/chess-arbiter.ts` _(güncellendi — S85 fix)_
Tam legal move engine (S85'te yeni, S85 fix'te Redis'e taşındı):
- Tüm taş hareketleri (piyon, şövalye, fil, kale, vezir, şah)
- **En passant**, **rok** (king-side + queen-side), **terfi**
- **Pin filtresi**: kendi şahını açıkta bırakan hamleler yasadışı
- **50 hamle kuralı**, **pat**, **şah mat** tespiti
- Socket event'leri: `chess:join`, `chess:move`, `chess:resign`, `chess:draw_offer`, `chess:draw_accept`
- Sunucu cevapları: `chess:joined`, `chess:started`, `chess:state`, `chess:move_applied`, `chess:game_over`, `chess:invalid`
- **S85 fix**: In-memory `_games` Map kaldırıldı → `chessStore` (Redis + in-memory fallback)

### `server/socket/handlers/activities/chess-store.ts` _(yeni — S85 fix)_
- Redis-backed oyun state yönetimi (`redisAdapter.cache` üzerinden)
- In-memory fallback: Redis yoksa (geliştirme/test) Map kullanılır
- TTL: 4 saat; terk edilen oyunlar otomatik temizlenir
- `chessStore.get / set / del` — tüm async, multi-instance güvenli

### `server/socket/handlers/activities.ts`
- `registerChessHandlers` import'u ve çağrısı eklendi.

### `server/tests/chess-arbiter.test.ts` _(güncellendi — S85 fix)_
- Mevcut testler korundu (başlangıç 20 hamle, fool's mate, pin, rok, en passant, terfi)
- Eklendi: queen-side rok, en passant capture, kale hareketinde rok hakkı kaybı,
  şah altında yalnızca legal hamlelerin döndüğü doğrulama, promoteTo=undefined varsayılanı
- `_clearAllGames_TEST_ONLY` artık `chessStore._clearMemGames_TEST_ONLY()` çağırıyor

---

## 3. Mobile Deep Link Genişletmesi

### `mobile/capacitor-bridge.js` _(güncellendi)_
Eski tek-satır `console.warn` yerine tam dispatch tablosu:

| Şema | Eylem |
|------|-------|
| `bridge://channel/:id` | `navigate:channel` |
| `bridge://dm/:userId` | `navigate:dm` |
| `bridge://server/:id` | `navigate:server` |
| `bridge://server/:id/channel/:id` | `navigate:channel` (server + channel) |
| `bridge://invite/:code` | `navigate:invite` |
| `bridge://activity/:channelId/:activityId` | `navigate:activity` |
| `bridge://settings[/:tab]` | `navigate:settings` |
| `bridge://auth/callback?token=` | `auth:callback` |

Dispatch `window.dispatchEvent(new CustomEvent('bridge:deeplink', { detail }))` ile ana uygulamaya iletiliyor. Her başarılı deep link'te `bridgeHaptic.light()` tetikleniyor.

### `mobile/tests/capacitor-bridge.test.js` _(güncellendi — S85 fix)_
- **S85 fix**: Deep link dispatch testleri eklendi (13 senaryo)
- Kapsanan URL pattern'leri: channel, dm, server, server+channel, invite, activity, settings (tab'lı ve tab'sız), auth/callback
- Edge case'ler: geçersiz şema, bilinmeyen path, boş URL, null URL

---

## 4. K8s Sealed Secrets

### `k8s/sealed-secret.yaml` _(yeni)_
- `SealedSecret` manifest şablonu (controller + kubeseal kurulum talimatları içinde).
- `encryptedData` alanları `REPLACE_WITH_KUBESEAL_OUTPUT` placeholder'ı ile — cluster'dan `kubeseal` ile üretilmeli.
- GitHub Actions CI entegrasyon örneği (GitHub Secrets → kubeseal → apply) dahil.

### `k8s/secret.yaml` _(güncellendi — S85 fix)_
- Artık kullanılmıyor; dosya içeriği uyarı notu ile replace edildi.

### `.gitignore` _(güncellendi — S85 fix)_
- `k8s/secret.yaml` artık `.gitignore`'da. Plaintext credential'ların yanlışlıkla commit edilmesi engelleniyor.

### `k8s/servicemonitor.yaml` _(yeni — S85 fix)_
- Prometheus Operator ServiceMonitor manifesti.
- `/metrics` endpoint'ini bearer token ile 15s interval scrape eder.
- `k8s/kustomization.yaml`'a eklendi.

### `k8s/kustomization.yaml` _(güncellendi — S85 fix)_
- `servicemonitor.yaml` resources listesine eklendi.

---

## Dosya Özeti

| Dosya | Durum |
|-------|-------|
| `client/js/core/i18n.ts` | Güncellendi |
| `client/css/modules/rtl.css` | **Yeni** |
| `server/socket/handlers/activities/chess-arbiter.ts` | Güncellendi (Redis store) |
| `server/socket/handlers/activities/chess-store.ts` | **Yeni** |
| `server/socket/handlers/activities.ts` | Güncellendi |
| `server/tests/chess-arbiter.test.ts` | Güncellendi (ek testler) |
| `mobile/capacitor-bridge.js` | Güncellendi |
| `mobile/tests/capacitor-bridge.test.js` | Güncellendi (deep link testleri) |
| `k8s/sealed-secret.yaml` | **Yeni** |
| `k8s/secret.yaml` | Deprecated (uyarı notu) |
| `k8s/servicemonitor.yaml` | **Yeni** |
| `k8s/kustomization.yaml` | Güncellendi |
| `.gitignore` | Güncellendi |
