# Bridge — Roadmap

---

## Mevcut Durum

### Tamamlanan Özellikler

| Kategori | Özellik |
|----------|---------|
| **Auth** | JWT + Refresh token rotasyonu, WebAuthn/Passkey (FIDO2), 2FA (TOTP) |
| **Mesajlaşma** | Real-time Socket.IO, düzenleme geçmişi, reaksiyonlar, thread |
| **Dosya** | Chunked upload (büyük dosyalar) |
| **Sesli** | WebRTC P2P ses kanalları, SFU group voice (Mediasoup) |
| **Roller** | Gelişmiş izin sistemi (kanal bazlı granüler) |
| **Moderasyon** | Ban/kick/timeout, auto-mod AI, IP ban, içerik tarama |
| **DM** | Direkt mesajlaşma + E2E şifreleme |
| **Arkadaşlar** | Arkadaş sistemi |
| **Keşif** | Sunucu keşif sayfası |
| **Bot** | Bot API + Webhook + SDK |
| **Poll** | Anket sistemi |
| **Soundboard** | Ses panosu |
| **Mobile** | PWA + Capacitor iOS/Android |
| **Güvenlik** | Redis cache, rate limiting, HTTP Signature |
| **Federasyon** | ActivityPub (followers/following/notes, NodeInfo, RSA key) |
| **AI** | Özet, çeviri, moderasyon, yanıt önerisi, semantik arama |
| **Plugin** | Plugin sistemi (sandbox izolasyonu) |
| **SSO** | Kurumsal SSO (harici bağımlılıksız) |
| **Audit Log** | Admin paneli audit log export |
| **Monitoring** | Prometheus + Grafana dashboard |
| **Test** | Jest (server) + Playwright (E2E) altyapısı |

---

## Kısa Vadeli Hedefler

### Performans & Güvenilirlik

**Veritabanı**
- SQLite → PostgreSQL geçişi (concurrent yazma sınırını aşmak için)
- CDN + WebP otomatik dönüşümü (`sharp`)
- Cloudflare R2 / MinIO medya depolama

**Önbellek**
- Mesaj cache TTL optimizasyonu
- User presence cache (online/offline)
- Channel list cache

### Sosyal Özellikler

**Topluluk Profilleri**
- Sunucu "hakkında" sayfası (web'den erişilebilir): `bridge.app/s/sunucu-adi`
- Üye sayısı, aktivite grafiği, son mesajlar (preview)

**Gelişmiş Profil**
- Bağlantılar: GitHub, Twitter, Steam, Spotify
- "Şu an çalınan" Spotify entegrasyonu
- Rozetler (kullanıcı başarıları)

**Keşif Güçlendirmesi**
- Haftalık "Öne Çıkan Sunucular"
- Kategori bazlı gezinme
- Gerçek zamanlı aktif üye sayısı

---

## Orta Vadeli Hedefler

### Altyapı

**Yatay Ölçekleme**
```
nginx (reverse proxy)
  ├── Node.js instance 1
  ├── Node.js instance 2
  └── Node.js instance N
      ↕
  Redis (pub/sub)
      ↕
  PostgreSQL (primary + replica)
```

Redis adapter mevcut — `REDIS_URL` ortam değişkeni yeterli.

**Monitoring**
- OpenTelemetry entegrasyonu
- Sentry error tracking
- Uptime monitoring

### AI Özellikleri

- Vektör embedding ile semantik mesaj arama
- Doğal dil sorguları ("bu haftaki önemli kararlar")
- Otomatik moderasyon pipeline (5 dk tarama döngüsü)
- Çok dilli arayüz (TR/EN/DE/FR)

---

## Uzun Vadeli Vizyon

### Bridge'i Discord'dan Ayıran 5 Temel Özellik

**1. Gerçek Gizlilik (E2EE)**
Mesajlar sunucuda şifreli; sağlayıcı okuyamaz. Altyapı hazır, production aktivasyonu yolda.

**2. Native AI Entegrasyonu**
Konuşma özeti, çeviri, öneri sistemi mevcut. Hedef: AI moderatör, AI kanal organizatörü.

**3. Tüm Premium Özellikler Ücretsiz**

| Özellik | Discord | Bridge |
|---------|---------|--------|
| Animasyonlu avatar | Nitro ($10/ay) | Ücretsiz |
| Profil banner | Nitro | Ücretsiz |
| Yüksek kalite ses | Nitro | Ücretsiz |
| Büyük dosya upload | Nitro | Yapılandırılabilir |

**4. Açık Kaynak & Federasyon**
ActivityPub ile farklı Bridge sunucuları birbirine bağlanabilir. Docker ile tek komut kurulum. Plugin/extension sistemi.

**5. Topluluk Analitiği**
Üye büyüme grafikleri, en aktif saatler, popüler içerikler, bağlılık skoru.

---

## Teknik Borç

| Öncelik | Görev |
|---------|-------|
| 🔴 Yüksek | Büyük modülleri klasör bazlı böl (`server/db/index.js`, büyük route dosyaları) |
| 🔴 Yüksek | Socket handler'ları için entegrasyon testleri (voice, stage, music) |
| 🟡 Orta | `node-fetch` → native `fetch` (Node 22+) |
| 🟡 Orta | Rate limit granülerliği artır (per-user IP tracking) |
| 🟡 Orta | Socket.IO room memory leak kontrolü |
| 🟢 Düşük | Client-side bundle optimizasyonu (tree shaking) |
| 🟢 Düşük | Erişilebilirlik: ARIA labels, keyboard navigation |
| ✅ Tamamlandı | CI/CD pipeline'ı Node 22 LTS için güncellendi (.nvmrc = 22, ci.yml node-version-file ile okur) |

---

## Başarı Metrikleri

| Dönem | Hedef |
|-------|-------|
| 6 ay | 1.000 aktif kullanıcı, <100ms ortalama API yanıt süresi, %99.5 uptime |
| 12 ay | 10.000 aktif kullanıcı, PostgreSQL geçişi tamamlandı, E2EE production aktif |
| 24 ay | 100.000 aktif kullanıcı, tam ActivityPub federasyonu, sürdürülebilir model |

---

## Sürdürülebilirlik

Bridge tamamen ücretsiz ve açık kaynak olarak konumlanmaktadır.

| Model | Durum |
|-------|-------|
| Reklam | ❌ Asla |
| Bireysel ücret | ❌ Tüm özellikler ücretsiz |
| Bağış (Ko-fi / GitHub Sponsors) | ✅ Açık kaynak için ideal |
| Self-hosting (altyapı maliyeti dağıtılır) | ✅ |
| Kurumsal deployment (ileride) | 🔮 Değerlendirilebilir |

---

*Son güncelleme: Nisan 2026 — Versiyon kaynağı: `package.json`*
