# Bridge Accessibility Audit Checklist

Bu doküman, hızlı ROI odaklı bir erişilebilirlik (A11Y) denetim planıdır.

## Başlangıç Durumu (Hızlı Sayım)

- `client/index.html` içinde `aria-` kullanım sayısı: **45** → **Sprint 16 sonrası: ~80**
- `onclick` kullanan `div` sayısı: **56** → kritik akışlar dönüştürüldü
- `role="dialog"` olan modal sayısı: **3** → **6**

---

## Tamamlanan Hemen Kazanımlar ✅

- [x] Temel modal'lara `role="dialog"` + `aria-modal="true"` eklendi:
  - `addserver-modal`, `invite-modal`, `schedule-modal`
  - `settings-modal`, `emoji-picker-modal`, `gif-modal` ← Sprint 16'da eklendi
- [x] Klavye tab döngüsü için global focus-trap eklendi (`a11y-focus-trap.js`)
- [x] `Escape` tuşu tüm modal'ları kapatıyor (`initGlobalEscapeHandler`)
- [x] Modal açılışında `data-autofocus` ile ilk odaklanma
- [x] Modal kapanınca `data-focus-return` ile önceki elemana geri dönüş
- [x] Marketplace ayrı sayfa olarak açılıyor — daha temiz odak akışı
- [x] `<html lang="tr">` etiketi eklendi
- [x] Tüm `<img>` etiketlerine anlamlı `alt` metni
- [x] Renk kontrastı WCAG AA (4.5:1) geçiyor

---

## Sprint 16 Yeni Deliverable'lar

### Yeni Dosyalar

| Dosya | Açıklama |
|-------|---------|
| `client/js/core/a11y-focus-trap.js` | Focus trap + Escape yönetimi |
| `client/js/core/a11y-keyboard.js` | Ok tuşu, roving tabindex, Space/Enter normalleştirme |
| `client/js/core/a11y-aria.js` | Live region, disclosure, popup, context menu ARIA |
| `client/partials/settings-modal.html` | `role="tab"`, `aria-selected`, `role="switch"` eklenmiş tam markup |
| `e2e/tests/a11y.smoke.spec.js` | axe-core + klavye akış + ARIA attribute testleri |

### settings-modal Değişiklikleri

- `role="dialog"` + `aria-modal="true"` + `aria-labelledby="settings-modal-title"`
- Sekme listesi: `role="tablist"`, her buton `role="tab"` + `aria-selected` + `aria-controls`
- Her panel: `role="tabpanel"` + `aria-labelledby` + `tabindex="0"`
- Push toggle: `role="switch"` + `aria-checked` + `aria-describedby`
- Kapat butonu: `aria-label="Ayarları kapat"`

### a11y-keyboard.js Kapsamı

- `initRovingTabindex(container, selector, orientation)` — kanal listesi, üye listesi
- `normalizeSpaceEnterClick(root)` — eski `div[onclick]` kalıpları
- `bindDropdownKeyboard(trigger, menu)` — sunucu/kanal dropdown'ları
- `initChannelListKeyboard()` — sayfa yüklenince otomatik kurulum

### a11y-aria.js Kapsamı

- `announcePolite(msg)` / `announceAssertive(msg)` — toast ve hata bildirimleri
- `bindDisclosure(trigger, target)` — accordion, kategori collapse
- `bindPopupAria(trigger, popup)` — dropdown ARIA state izleme
- `patchSettingsModalAria()` — JS ile sekme ARIA ilişkileri
- `patchContextMenuAria(menu)` — sağ-tık menü

---

## Manuel Test Planı

### 1) Klavye Navigasyonu

- [x] Login ekranı: sadece klavye ile tamamlanabiliyor
- [x] Sol panel → kanal listesi → mesaj gönderme `Tab` + `Enter`
- [x] Ok tuşlarıyla kanal listesi navigasyonu (`ArrowDown`/`ArrowUp`)
- [x] Modal açıkken odak modal dışına kaçmıyor
- [x] `Escape` açık modal/paneli kapatıyor
- [x] `Ctrl/Cmd+K` arama kısayolu odağı doğru input'a taşıyor
- [x] Dropdown/context menü `ArrowDown`/`Escape` ile çalışıyor

### 2) Modal ve Focus Trap

- [x] `a11y-focus-trap.js` tüm modal'lara uygulandı
- [x] Modal açılışında `data-autofocus` elementi odaklanıyor
- [x] Modal kapanınca tetikleyiciye focus dönüyor

### 3) Screen Reader Testi

- [x] VoiceOver/NVDA ile login alanları okunuyor
- [x] Toast mesajları `aria-live="assertive"` bölgesinden
- [x] Bilgi anonsları `aria-live="polite"` bölgesinden
- [x] İkon butonların anlamlı `aria-label` değerleri var
- [x] Settings modal sekmeleri `role="tab"` / `aria-selected` ile okunuyor
- [x] Push toggle `role="switch"` + `aria-checked` ile açık/kapalı bildiriliyor

### 4) Semantik ve ARIA Tutarlılığı

- [x] Kritik akış `div[onclick]` → `<button>` dönüşümü
- [x] `tabindex="0"` elemanlarda Space + Enter çalışıyor
- [x] Form `label` + `input` eşleştirmeleri doğrulandı
- [x] Context menüde `role="menu"` + `role="menuitem"` + `role="separator"`

---

## CI Entegrasyonu ✅

`e2e/tests/a11y.smoke.spec.js` — aşağıdaki kontroller otomatik çalışıyor:

- `axe-core` tabanlı sayfa taraması (login, ana ekran, ayarlar)
- Klavye akışı: login, Escape, Tab döngüsü, kanal ok tuşları
- ARIA attribute doğrulama: modal, push toggle, icon butonlar
- WCAG 2.1 AA kuralları; `color-contrast`, `keyboard`, `aria-*` kritik öncelikte

---

## Öncelik Sırası (ROI) — Güncellendi

| # | Görev | Durum |
|---|-------|-------|
| 1 | Modal'lar `role="dialog"` + focus yönetimi | ✅ Tamamlandı |
| 2 | `onclick div` → `button` kritik akışlarda | ✅ Tamamlandı |
| 3 | `aria-live` mesajlaşma akışı | ✅ Tamamlandı |
| 4 | CI A11Y smoke testi (axe + klavye) | ✅ Tamamlandı |
| 5 | `a11y-focus-trap.js` merkezi modül | ✅ Sprint 16 |
| 6 | `a11y-keyboard.js` roving tabindex + dropdown | ✅ Sprint 16 |
| 7 | `a11y-aria.js` live region + ARIA binding | ✅ Sprint 16 |
| 8 | settings-modal tam ARIA markup | ✅ Sprint 16 |

---

## Sprint 108 — WCAG 2.1 AA Tamamlama ✅

`client/js/core/a11y-wcag-aa.ts` modülü eklendi:

- [x] Skip navigation link — `#main-content` hedefli, odakta görünür
- [x] ARIA landmark patch — `channel-list`, `messages-container`, `member-list`, `voice-bar`, `stage-area`
- [x] `prefers-reduced-motion` izleyici — `data-reduced-motion` attribute, CSS entegrasyonu
- [x] Ses kanalı/stage ARIA live region — katılım/ayrılış/konuşmacı duyuruları
- [x] `voice-bar` complementary landmark + mute/deafen aria-pressed
- [x] `stage-area` region landmark + konuşmacı announcePolite
- [x] Color contrast hesaplayıcı — WCAG 1.4.3 (4.5:1) ve 1.4.6 (7:1) formülleri
- [x] `initA11yWcagAA()` — tek çağrıyla tüm düzeltmeler + MutationObserver

## Backlog (Sonraki Sprint'ler)

- [ ] Kalan 92 `div[onclick]` → `button` dönüşümü (kritik olmayan akışlar)
- [ ] `prefers-contrast: more` yüksek kontrast tema
- [ ] WCAG 2.2 AAA: `:focus-visible` odak göstergesi güçlendirmesi
- [ ] Form hata mesajları: `aria-describedby` + `aria-invalid` (Sprint 109 hedefi)

---

## Referanslar

- [WCAG 2.1 Hızlı Referans](https://www.w3.org/WAI/WCAG21/quickref/)
- [APG Modal Dialog Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/)
- [APG Menu Button Pattern](https://www.w3.org/WAI/ARIA/apg/patterns/menu-button/)
- [axe-core Rules](https://dequeuniversity.com/rules/axe/4.7)
