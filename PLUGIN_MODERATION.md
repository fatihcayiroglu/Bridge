# Bridge Plugin Ekosistemi — Moderasyon & Kürasyon Stratejisi

> Sprint 64'te oluşturuldu. Bu belge bot/plugin marketplace'inin büyümesini
> nasıl yöneteceğimizi tanımlar: teknik doğrulamanın ötesinde içerik,
> güvenlik ve ekosistem sağlığı kurallarını kapsar.

---

## 1. Mevcut Durum

`plugins/allowlist.ts` aşağıdaki teknik kontrolleri yapar:

- `id`, `name`, `version` alanlarının varlığı
- `id` format kontrolü (`/^[a-z0-9_-]{2,64}$/`)
- Semver uyumlu versiyon

Bu kontroller **gerekli ama yeterli değil**. Teknik olarak geçerli bir bot
zararlı içerik barındırabilir, kötüye kullanılabilir veya ekosistemi
manipüle edebilir.

---

## 2. Yayınlanma Yolu (3 Katman)

### Katman 1 — Otomatik Teknik Doğrulama (mevcut)
`allowlist.ts` + CI lint/test geçişi zorunlu.

### Katman 2 — Küratör İncelemesi (YENİ)

İlk yayınlama ve her major sürüm için en az **1 küratör onayı** gerekir.
Küratörler; kodu, açıklamayı ve manifest'i inceler.

**İnceleme kontrol listesi:**

```
[ ] Bot açıklaması Türkçe ve İngilizce mevcut
[ ] Hangi izinlere eriştiği manifest'te açıkça belirtilmiş
[ ] Sadece bildirilen işlemleri yapıyor (kod incelemesi)
[ ] Harici istekler yapıyorsa hedef domain'ler manifest'te listeleniyor
[ ] Kullanıcı verisi toplamıyorsa veya açıkça bildirim yapılıyor
[ ] Açık kaynak depoya link var veya binary-only için güvenlik audit raporu
[ ] Kategori doğru seçilmiş (Müzik / Moderasyon / Eğlence / Araçlar / …)
```

### Katman 3 — Topluluk Geri Bildirimi

- Her bot sayfasında **Raporla** butonu
- 5+ rapor → otomatik küratör bildirim
- `Doğrulanmış` rozeti: 30+ aktif sunucuda 30 gün sorunsuz çalışmış botlar

---

## 3. İzin Modeli

Bot manifest'i hangi izinlere ihtiyaç duyduğunu belirtmeli:

```json
{
  "id": "music-bot",
  "name": "Music Bot",
  "version": "1.2.0",
  "permissions": [
    "READ_MESSAGES",
    "SEND_MESSAGES",
    "CONNECT_VOICE",
    "MANAGE_QUEUE"
  ],
  "externalDomains": [
    "youtube.com",
    "soundcloud.com"
  ],
  "dataCollection": false
}
```

**Yasaklı izinler** (hiçbir bot talep edemez):

- `MANAGE_ADMIN` — admin yetkisi
- `READ_ALL_DMS` — tüm özel mesajları okuma
- `EXPORT_USERS` — kullanıcı verisini dışa aktarma
- `WEBHOOK_ANY_URL` — rastgele URL'ye webhook

---

## 4. İçerik Kuralları

### 4.1 Yasak İçerik

Aşağıdaki amaçlarla kullanılan botlar marketplace'ten çıkarılır ve yasaklanır:

| Kategori | Örnekler |
|----------|----------|
| Spam / flood | Otomatik mesaj patlaması, mention spam |
| Phishing | Sahte login sayfası, token harvesting |
| NSFW (izinsiz) | Açık içerik üretimi / dağıtımı — yalnızca NSFW işaretli sunuculara izin verilir |
| Otonom moderasyon bypass | Anti-raid botlarını etkisizleştirme |
| Veri sızdırma | Kullanıcı bilgilerini 3. tarafa gönderme |
| Kripto/NFT yanıltma | Pump-and-dump promosyonu |

### 4.2 Kısıtlı İçerik (Onaya Tabi)

- **NSFW kategorisi:** Sunucu `nsfw: true` işaretli olmalı
- **Ticari botlar:** Ödeme entegrasyonu içerenler ek bir ticari incelemeye tabi
- **AI içerik üretimi:** Hangi modeli kullandığı belirtilmeli

---

## 5. Güvenlik Gereksinimleri

### 5.1 allowlist.ts Genişletmesi

`plugins/allowlist.ts`'e eklenmesi önerilen kontroller:

```typescript
// Sprint 64 sonrası eklenecek alanlar

// Harici domain sınırı
const MAX_EXTERNAL_DOMAINS = 10;
if (Array.isArray(meta.externalDomains) && meta.externalDomains.length > MAX_EXTERNAL_DOMAINS) {
  console.warn(`[Allowlist] Rejected: too many external domains (${meta.externalDomains.length})`);
  return false;
}

// NSFW flag kontrolü
if (meta.nsfw && typeof meta.nsfw !== 'boolean') {
  console.warn('[Allowlist] Rejected: invalid nsfw flag');
  return false;
}

// İzin listesi — yasaklı izin var mı?
const BANNED_PERMS = ['MANAGE_ADMIN', 'READ_ALL_DMS', 'EXPORT_USERS', 'WEBHOOK_ANY_URL'];
if (Array.isArray(meta.permissions)) {
  for (const perm of meta.permissions) {
    if (BANNED_PERMS.includes(String(perm))) {
      console.warn(`[Allowlist] Rejected: banned permission "${perm}"`);
      return false;
    }
  }
}
```

### 5.2 Rate Limit (Bot API)

Bot API endpoint'leri zaten `rateLimit` middleware kullanıyor.
Ek olarak:

- Bot başına **günlük 10.000 API isteği** soft limiti (aşımda uyarı, 2× aşımda geçici askı)
- Webhook dağıtımı **50 req/sn** ile kısıtlı
- Bot token'ları 90 günde bir otomatik rotasyona tabi (uyarı 7 gün önceden)

### 5.3 Sandbox (Gelecek Sprint)

Güvenilir olmayan bot kodunu Node.js `vm` modülü veya ayrı bir process'te
çalıştırma — plugin host mimarisi için teknik araştırma Sprint 65'e planlandı.

---

## 6. Küratör Roller & Sorumluluklar

| Rol | Sorumluluk | Kişi Sayısı |
|-----|-----------|-------------|
| **Baş Küratör** | Strateji, kural güncellemeleri, escalation | 1 |
| **Teknik Küratör** | Kod incelemesi, güvenlik | 2+ |
| **İçerik Küratörü** | Açıklama, kategori, uygunluk | 2+ |
| **Topluluk Temsilcisi** | Kullanıcı raporlarını işleme | 1+ |

Küratörler gönüllü veya ücretli çalışabilir. Seçim kriterleri:
- Bridge topluluğunda en az 3 aylık aktif üyelik
- Önceki moderasyon deneyimi (tercih)
- İnceleme SLA: **72 saat** (ilk yanıt)

---

## 7. Kaldırma Süreci

```
Rapor alındı
  → Otomatik: 5+ rapor → küratör bildirim
  → Manuel: doğrudan küratör bildirimi

Küratör incelemesi (48 saat)
  → Temiz: rapor reddedilir, bot temizlenir
  → İhlal tespit:
      - Minor: bot sahibine uyarı, 7 gün düzeltme süresi
      - Major: bot anında askıya alınır (sunuculardan devre dışı)
      - Kritik (güvenlik/veri): anında kalıcı yasaklama

Bot sahibi itiraz edebilir → Baş Küratör kararı 5 iş günü içinde
```

---

## 8. Bot Marketplace Roadmap

| Öncelik | Özellik | Sprint Hedefi |
|---------|---------|--------------|
| 🔴 Yüksek | Küratör onay kuyruğu (admin panel) | Sprint 65 |
| 🔴 Yüksek | allowlist.ts izin/domain genişletmesi | Sprint 65 |
| 🟡 Orta | Bot sayfası Raporla butonu | Sprint 66 |
| 🟡 Orta | Doğrulanmış rozeti sistemi | Sprint 66 |
| 🟢 Düşük | Sandbox / process isolation PoC | Sprint 67+ |
| 🟢 Düşük | Bot analitik panosu (bot sahibine) | Sprint 67+ |

---

## 9. Referanslar

- `plugins/allowlist.ts` — mevcut teknik doğrulama
- `server/routes/bots.ts` — Bot API endpoint'leri
- `client/js/core/bot-marketplace/` — Marketplace UI
- `CONTRIBUTING.md` — genel katkı kuralları
