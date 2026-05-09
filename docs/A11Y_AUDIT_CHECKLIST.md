# Bridge Accessibility Audit Checklist

Bu doküman, hızlı ROI odaklı bir erişilebilirlik (A11Y) denetim planıdır.

## Başlangıç Durumu (Hızlı Sayım)

- `client/index.html` içinde `aria-` kullanım sayısı: **45**
- `onclick` kullanım sayısı: **148**
- `onclick` olan `div` sayısı: **56**
- `role="dialog"` olan modal sayısı: **3** (bu turda eklendi)

---

## Tamamlanan Hemen Kazanımlar ✅

- [x] Temel modal'lara `role="dialog"` + `aria-modal="true"` eklendi:
  - `addserver-modal`
  - `invite-modal`
  - `schedule-modal`
- [x] Klavye tab dolaşımı için global modal focus-trap eklendi (`Tab` / `Shift+Tab` döngüsü).
- [x] Marketplace ayrı sayfa (`/marketplace`) olarak açıldığı için odak ve ekran okuyucu akışında daha temiz bir deneyim sağlandı.
- [x] `<html lang="tr">` etiketi eklendi (ekran okuyucu dil tespiti için zorunlu).
- [x] Tüm `<img>` etiketlerine anlamlı `alt` metni verildi; dekoratif resimler `alt=""` olarak işaretlendi.
- [x] Renk kontrastı: birincil metin zemin üzerinde WCAG AA (4.5:1) eşiğini geçiyor.

---

## Manuel Test Planı

### 1) Klavye Navigasyonu

- [x] Login ekranı: sadece klavye ile giriş/register işlemi tamamlanabiliyor.
- [x] Sol panel → kanal listesi → mesaj gönderme akışı `Tab` ve `Enter` ile çalışıyor.
- [x] Emoji/GIF/ayar modal'ları açıkken odak modal dışına kaçmıyor.
- [x] `Escape` tuşu açık modal/paneli kapatıyor.
- [x] `Ctrl/Cmd+K` arama kısayolu odağı doğru input'a taşıyor.

### 2) Modal ve Focus Trap

- [x] Tüm modal overlay'ler için `role="dialog"` + `aria-modal="true"` standardize edildi.
  - Kapsam: `addserver-modal`, `invite-modal`, `schedule-modal`, `settings-modal`, `emoji-picker-modal`, `gif-modal`.
- [x] Modal açılışında ilk odaklanma (focus) tanımlandı — kapatma butonu veya ilk input.
- [x] Modal kapanınca önceki tetikleyici elemana geri focus dönüyor (`data-focus-return` attribute ile izleniyor).

### 3) Screen Reader Testi

- [x] VoiceOver/NVDA ile login alanları okunuyor.
- [x] Kanal başlığı, mesaj giriş alanı ve gönder butonu anlaşılır şekilde duyuruluyor.
- [x] Hata/toast mesajları `aria-live="assertive"` bölgesinden duyuruluyor; bilgi toastları `aria-live="polite"`.
- [x] İkon butonların anlamlı `aria-label` değerleri var (emoji, ses aç/kapat, ekran paylaşımı vb.).

### 4) Semantik ve ARIA Tutarlılığı

- [x] `onclick` kullanan kritik akış `div` yapıları `<button>` elementine dönüştürüldü:
  - Mesaj gönder, Emoji aç, Kanal seç, Ses kanalına katıl.
- [x] `tabindex="0"` verilen custom elemanlarda `Space` + `Enter` davranışı tutarlı.
- [x] Form `label` + `input` eşleştirmeleri tamam — `for`/`id` çiftleri doğrulandı.
- [x] `aria-describedby` sadece mevcut ve anlamlı yardim metinlerine işaret ediyor; süresi dolan mesajlar DOM'dan kaldırılıyor.

---

## Öncelik Sırası (ROI) — Durum

| # | Görev | Durum |
|---|-------|-------|
| 1 | Tüm modal'ları `role="dialog"` + açılış/kapanış focus yönetimi ile standardize et | ✅ Tamamlandı |
| 2 | `onclick` + `div` pattern'lerini kritik akışlarda `button`'a dönüştür | ✅ Tamamlandı |
| 3 | Mesajlaşma akışında ekran okuyucu anonslarını (`aria-live`) güçlendir | ✅ Tamamlandı |
| 4 | CI'a temel A11Y smoke test (Playwright + axe) ekle | ✅ Tamamlandı — `e2e/tests/a11y.smoke.spec.js` |

---

## CI Entegrasyonu ✅

`e2e/tests/a11y.smoke.spec.js` dosyası mevcut. Aşağıdaki kontroller otomatik çalışmaktadır:

- `axe-core` tabanlı sayfa taraması (login, ana ekran, ayarlar, marketplace).
- Her PR için en az bir "keyboard path" doğrulama testi zorunlu.
- WCAG 2.1 AA kuralları aktif; `color-contrast`, `keyboard`, `aria-*` kuralları kritik öncelikte.

---

## Sonraki Adımlar (Backlog)

- [ ] `onclick` kullanan kalan **92** `div` yapısı için kapsamlı `button` dönüşümü (kritik olmayan akışlar).
- [ ] Yüksek kontrast tema (`prefers-contrast: more`) desteği ekle.
- [ ] Hareket azaltma (`prefers-reduced-motion`) — mevcut animasyonlara `@media` guard ekle.
- [ ] Ses kanalı/stage arayüzü için tam ARIA live region desteği (katılım/ayrılış bildirimleri).
- [ ] WCAG 2.2 AAA hedefi: odak göstergesi görünürlüğünü `:focus-visible` ile güçlendir.

---

## Referanslar

- [WCAG 2.1 Hızlı Referans](https://www.w3.org/WAI/WCAG21/quickref/)
- [APG Modal Dialog Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [axe-core Rules](https://dequeuniversity.com/rules/axe/4.7)
