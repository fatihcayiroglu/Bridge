# SPRINT 91 DEĞİŞİKLİKLERİ
## Bridge Discord Parité Güncellemesi

**Yayın tarihi:** Sprint 91
**Etki alanı:** 8 yeni modül, 2 sunucu route, 1 CSS paketi, 1 DB extension

---

## 🆕 YENİ ÖZELLİKLER

### 1. 🎭 Sunucu Profili (Per-Server Profile)
**Dosya:** `client/js/core/server-profile.ts` + `server/routes/serverMemberProfile.ts`

Discord'un "Edit Server Profile" özelliğinin tam karşılığı.

- Sunucu bazlı takma ad (global adından bağımsız, 32 karakter)
- Sunucuya özel biyografi (190 karakter)
- Zamirler alanı (they/them, o/ona vb.)
- Sunucu profil avatarı (global avatardan bağımsız, 256×256 WebP)
- Profil banner görseli (1024×256 WebP) veya renk seçici
- Canlı önizleme kartı modal içinde
- `sharp` ile sunucu tarafında otomatik yeniden boyutlandırma
- Socket üzerinden anlık güncelleme (diğer üyeler hemen görür)
- Eski dosyaların sunucudan otomatik silinmesi

**Entegrasyon:** Sunucu sağ tık menüsüne "🎭 Sunucu Profilimi Düzenle" ekle

---

### 2. 🔔 Granüler Bildirim Tercihleri
**Dosya:** `client/js/core/notification-prefs.ts` + `server/routes/notificationPrefs.ts`

Discord'un kanal/sunucu bazlı bildirim sistemi.

- **Kanal bazlı:** Tüm Mesajlar / Sadece @Mention / Sessize Al / Sunucu Varsayılanı
- **Zamanlı susturma:** 15dk / 1s / 3s / 8s / 24s / Sonsuza kadar
- **Sunucu bazlı override:** Tüm kanallar için temel seviye
- Kanal listesinde 🔕 rozeti (muted kanallar)
- Sessiz kanallarda unread sayacı gizleme
- Socket senkronizasyonu (birden fazla sekme/cihaz)
- **Bug fix:** `moderation.ts` içinde `notif-ctx` → `notif-ctx-menu` ID düzeltmesi

**Entegrasyon:** Kanal sağ tık menüsüne "🔔 Bildirim Tercihleri" ekle

---

### 3. 🤖 Bot Marketi (Bot Marketplace)
**Dosya:** `client/js/core/bot-marketplace/`

Discord benzeri bot ekosistemi arayüzü.

- **20 küratörlü bot** hazır katalogda (9 kategori)
- Arama, kategori filtresi, sıralama (Popüler / Puan / A-Z)
- Her bot için detay sayfası: açıklama, komutlar, istatistikler
- "Öne Çıkan" rozetleri, doğrulanmış/premium etiketleri
- Sunucuya ekleme akışı (API entegrasyonu)
- **Özel Bot Ekle:** token + webhook URL ile kendi botunu bağla
- Kurulu botların görsel işareti

**Entegrasyon:** Sunucu menüsüne "🤖 Bot Marketi" ekle

---

### 4. 📈 Gelişmiş Sunucu Keşfi
**Dosya:** `client/js/core/discover-enhanced.ts`

Mevcut `discover.ts`'in üzerine kurulmuş gelişmiş keşif motoru.

- **Trending algoritması:** `log(members) × onlineRatio × recencyBoost × verifiedBoost × boostMultiplier`
- 4 tab: Öne Çıkan / Trend / Yeni / Sizin İçin
- 10 kategori çipi
- Hero arama banner'ı
- Canlı online sayaç (Socket.io üzerinden 30s güncelleme)
- Sayfalama (18/sayfa, önceki/sonraki + sayfa numaraları)
- İskelet yükleme animasyonu
- Sunucu banner görseli desteği
- Boost seviyesi / verified / yeni rozetleri

---

### 5. 🎵 Soundboard (Ses Efekti Paneli)
**Dosya:** `client/js/core/soundboard-ui.ts`

Sesli kanaldayken kullanılabilen ses efekti paneli.

- **12 dahili ses** (emoji tabanlı, oscillator ile üretilen, dosya gerektirmez)
- Sunucu özel ses yükleme (MP3/OGG/WAV, max 512KB, max 5s)
- Kategori filtresi (Eğlence / Tepki / Müzik / Bildirim / Diğer)
- Arama ve global ses seviyesi kontrolü
- 2 saniyelik cool-down (spam önleme)
- Sesli kanal araç çubuğuna otomatik enjeksiyon
- Drag & drop yükleme arayüzü
- WebRTC ses kanalına enjeksiyon eventi

---

### 6. 🧵 Thread Arşiv Paneli
**Dosya:** `client/js/core/thread-archive.ts`

Mevcut thread altyapısının üzerine Discord benzeri thread yönetimi.

- Kanal başlığında aktif thread sayacı rozeti
- Sağ panelde thread listesi (aktif / arşivlenmiş tab)
- Thread arama
- Thread arşivleme / arşivden çıkarma (tek tıkla)
- Otomatik arşiv süresi görüntüleme ve ayarlama (1s/24s/3g/1h)
- Kilitli / pinlenmiş / arşivlenmiş rozetleri
- Son mesaj zamanı, mesaj sayısı, katılımcı sayısı
- Animasyonlu side panel (sağdan süzülme)

---

### 7. 📱 Mobil Ses Kanalı Kalıcılığı
**Dosya:** `mobile/capacitor-bridge-voice.ts`

Discord'un mobilde ses kanalında kalma deneyiminin karşılığı.

- **Floating voice bar:** Başka kanala geçince yeşil şerit göster
- Geçen süre sayacı (1:23, 45s formatında)
- Şerit üzerinden sesi kapat/aç butonu
- Şerit üzerinden kanaldan ayrıl butonu
- **iOS:** `WakeLock` API ile arka plan ses kilidi
- **Android:** Native `startVoiceForegroundService` çağrısı
- Capacitor `KeepAwake` ve `NativeAudio` plugin entegrasyonu
- App badge (1 = sesli kanaldasın göstergesi)
- Sayfa navigasyonunda floating bar'ı yeniden oluşturma

---

## 🐛 BUG FIX

### moderation.ts — notif-ctx ID uyuşmazlığı
```diff
- document.getElementById('notif-ctx')
+ document.getElementById('notif-ctx-menu')
```
`showNotifCtx()` ve `hideNotifCtx()` fonksiyonlarında 2 satır — bu fix olmadan
bildirim tercih menüsü hiç açılmıyordu.

---

## 📦 YENİ DOSYALAR

| Dosya | Açıklama |
|-------|----------|
| `client/js/core/server-profile.ts` | Per-server profil modali |
| `client/js/core/notification-prefs.ts` | Granüler bildirim tercihleri |
| `client/js/core/bot-marketplace/catalog-data.ts` | 20 bot katalog verisi |
| `client/js/core/bot-marketplace/index.ts` | Bot marketi UI |
| `client/js/core/discover-enhanced.ts` | Gelişmiş sunucu keşfi |
| `client/js/core/soundboard-ui.ts` | Soundboard paneli |
| `client/js/core/thread-archive.ts` | Thread arşiv paneli |
| `mobile/capacitor-bridge-voice.ts` | Mobil ses kalıcılığı |
| `server/routes/serverMemberProfile.ts` | Per-server profil API |
| `server/routes/notificationPrefs.ts` | Bildirim tercihleri API |
| `server/db/repositories/NotificationRepository.extension.ts` | DB metotları |
| `client/css/modules/sprint91.css` | Tüm yeni stiller |
| `client/js/app-init.sprint91.ts` | Entegrasyon kılavuzu |

---

## 🔧 DEĞİŞTİRİLMESİ GEREKEN MEVCUT DOSYALAR

| Dosya | Değişiklik |
|-------|-----------|
| `client/js/core/moderation.ts` | 2 satır ID fix |
| `client/js/core/channel-list.ts` | Kanal menüsüne 2 yeni seçenek |
| `client/js/core/discover.ts` | `initDiscoverEnhanced()` çağrısı |
| `client/js/voice.ts` | Soundboard toolbar enjeksiyonu |
| `mobile/capacitor-bridge.js` | Voice persistence init |
| `server/index.ts` | 2 yeni route ve DB index |
| `server/socket.ts` | 3 yeni socket event |
| `client/index.html` | sprint91.css link etiketi |

---

## 📊 DISCORD PARİTE GÜNCELLEME

| Özellik | Önceki | Sonraki |
|---------|--------|---------|
| Thread Yönetimi | 3/10 | 7/10 |
| Bildirim Granülasyonu | 4/10 | 9/10 |
| Per-Server Profil | 2/10 | 8/10 |
| Soundboard | 1/10 | 8/10 |
| Bot Ekosistemi | 4/10 | 7/10 |
| Sunucu Keşfi | 4/10 | 8/10 |
| Mobil Ses Deneyimi | 3/10 | 7/10 |
| **Genel Parité** | **~6/10** | **~7.8/10** |
