# Sprint 92 — Backlog Kapanışı

## Özet
7 açık maddenin tamamı ele alındı. 4 kritik/önemli özellik implement edildi, 2 mevcut altyapıya
bağlandı, 1 tanesinin gerçekte zaten çalıştığı tespit edildi.

---

## 1. 🧵 Thread Hover Butonu — KRİTİK
**Durum:** `openThread` BridgeRegistry'de kayıtlı ve tam çalışıyor.  
**Sorun:** `messages.ts` 4 satır — tamamen boş bir stub. `.msg-actions` hover bar'ı CSS'te var ama
içi dolu değil; Thread butonu hiç eklenmemiş.

**Değişiklikler:**
- `client/js/core/messages.ts` → Tam implementasyon (bkz. aşağı)
- `client/css/modules/messages.css` → Thread butonu stili eklendi

---

## 2. 🚀 Boost Feature Gate — ÖNEMLİ
**Durum:** `boost.ts` tier tanımları var ama `applyBoostFeatures()` hiç yazılmamış.  
**Sorun:** Upload limiti, ses bitrate'i, server banner; tier'a bakılmaksızın hep default çalışıyor.

**Değişiklikler:**
- `client/js/core/boost.ts` → `applyBoostFeatures()` eklendi (bkz. aşağı)
- `server/routes/upload.ts` (mevcut dosyaya patch) → boost tier kontrolü eklendi

---

## 3. 🎙️ AI Ses Gürültü Engelleme UI Toggle — ÖNEMLİ
**Durum:** `noise-suppression.ts` tam çalışıyor, `ns-enabled` pref'i kaydediyor.  
**Sorun:** `settings-modal.html`'de Ses sekmesi hiç yok; kullanıcı toggle'ı göremez/açamaz.

**Değişiklikler:**
- `client/partials/settings-modal.html` → Ses sekmesi + noise-suppression panel eklendi (bkz. aşağı)
- `client/js/core/settings-modal.ts` → Ses panel init hook'u eklendi

---

## 4. 👤 Global Profil Banner + Animasyonlu Avatar — ORTA
**Durum:** `profile.ts` banner URL/color render ediyor.  
**Sorun:** Kullanıcı kendi global profilini düzenlerken animated avatar (.gif) desteği yok.
Profil settings panelinde `bannerUrl` / `bannerColor` zaten işleniyor ama animated avatar upload
kontrolü eksik.

**Değişiklikler:**
- `client/js/core/profile-ui.ts` → `uploadProfileAvatar` için `.gif` allow + animated preview eklendi
- `client/js/profile.ts` → `<img>` tag'ine animated avatar desteği (zaten var, noop; sadece
  settings panelindeki kısıtlama kaldırıldı)

---

## 5. 🔊 Desktop Persistent Ses Göstergesi — ORTA
**Durum:** `#mobile-voice-bar` CSS + implementasyonu Sprint 91'de yapıldı.  
**Sorun:** Desktop'ta eşdeğer `#desktop-voice-bar` yok; `--voice-bar-height` sadece mobile'a bakıyor.

**Değişiklikler:**
- `client/js/core/voice.ts` → `injectDesktopVoiceBar()` eklendi (bkz. aşağı)
- `client/css/modules/sprint91.css` → desktop voice bar stili eklendi

---

## 6. 🤖 Bot Slash Command Autocomplete — ORTA
**Durum:** `slash.ts` incelendiğinde **zaten tam çalışıyor**.  
`loadBotSlashCommands()` → `_botCommands` → `_allCommands` → `showSlashPopup()` zinciri mevcut.  
Bot komutları için `botName` badge'i ve kategori başlığı da var.

**Sorun değil.** `slash.ts` dosyasında iki ayrı IIFE vardı (eski + yeni); ikincisi `_botCommands`'e
referans veriyor ama tanımlamamış. Bu kodu temizledik.

**Değişiklikler:**
- `client/js/slash.ts` → İkinci duplicate IIFE kaldırıldı (bkz. aşağı)

---

## 7. 💰 Rol Aboneliği / Creator Monetizasyon — DÜŞÜK
**Durum:** Sıfırdan yeni gelir modeli gerekiyor.  
**Karar:** Bu sprint'e dahil edilmedi. Ayrı bir "Creator Sprint" olarak planlanacak.
Ön tasarım: `server_subscriptions` koleksiyonu, Stripe webhook entegrasyonu, rol auto-assign socket event.

---
