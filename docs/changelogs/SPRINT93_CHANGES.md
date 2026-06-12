# Sprint 93 — Altyapı Kapanışı

**Kapsam:** Boost ekonomisi sunucu tarafı, Vanity URL, Spotify OAuth, E2EE production toggle, Upload limit enforcement

---

## 1. 🚀 Boost Ekonomisi — Server-Side

**Yeni dosya:** `server/routes/boosts.ts`

- `GET  /api/v1/servers/:sid/boosts` — Tier, boost sayısı, özellikler, booster listesi
- `POST /api/v1/servers/:sid/boosts` — Boost satın al (409 duplicate guard)
- `DELETE /api/v1/servers/:sid/boosts` — Boost iptal
- `GET  /api/v1/servers/vanity/:slug` — Vanity URL resolve
- `PATCH /api/v1/servers/:sid/vanity` — Vanity URL ayarla (Tier 3 gerekli)
- `boostCount` ve `boostTier` otomatik güncelleme

**DB:** `server_boosts` tablosu, `servers.vanityUrl`, `servers.boostCount`, `servers.boostTier`

---

## 2. 🔗 Vanity URL — Tam İmplementasyon

Sunucu sahibi + Tier 3 koşulunda `bridge.app/sunucu-adi` formatında custom URL.

- Validasyon: 3-32 karakter, `[a-z0-9-]`
- Rezerv slug koruması: api, admin, login, vs.
- Çakışma kontrolü

---

## 3. 📁 Upload Limit — Server-Side Enforcement

**Değişen:** `server/routes/upload.ts`

`getBoostUploadLimitBytes()` — kullanıcının üye olduğu en yüksek boost tier'lı sunucuyu baz alır.  
Tier 0→1: 25MB, Tier 2: 50MB, Tier 3: 100MB.  
Artık client bypass edilse bile server reddeder → 413 + `BOOST_LIMIT` kodu.

---

## 4. 🎵 Spotify OAuth — Tam Entegrasyon

**Yeni dosya:** `server/routes/spotify-oauth.ts`

- `GET /api/v1/oauth/spotify` — OAuth akışını başlat
- `GET /api/v1/oauth/spotify/callback` — Token exchange + DB kayıt
- `GET /api/v1/oauth/spotify/now-playing` — Şu an çalınan (otomatik token refresh)
- `DELETE /api/v1/oauth/spotify` — Bağlantıyı kes

**Client:** `client/js/core/spotify-widget.ts`
- Sidebar'da animasyonlu "Şu An Çalınan" bar (30s poll)
- Ayarlar > Profil'de OAuth bağlantı/kesme butonu
- Token expiry otomatik refresh

**Env:** `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REDIRECT_URI`

---

## 5. 🔒 E2EE Production Toggle

**Değişen:** `server/socket/handlers/channelE2EEHandlers.ts`, `server/lib/e2e.ts`

- `BRIDGE_E2EE_ENABLED=false` (varsayılan) → tüm E2EE socket event'leri devre dışı, setup reddedilir
- `BRIDGE_E2EE_ENABLED=true` → tam aktif
- `GET /api/v1/e2e/feature-status` → public endpoint, client UI buna göre render eder
- Ayarlar > Gizlilik'te E2EE durum paneli + anahtar iptal butonu

---

## 6. 🎨 Client UI

**Yeni dosyalar:**
- `client/js/core/boost-ui.ts` — Tier görüntüleme, boost satın al, vanity URL ayarı
- `client/js/core/spotify-widget.ts` — Now Playing bar + bağlantı ayarları
- `client/js/core/e2ee-toggle.ts` — Production flag UI + ayarlar paneli
- `client/css/modules/sprint93.css` — Tüm yeni stiller

---

## 7. 📦 DB Migration

`server/db/migrations_pg/011_sprint93_boost_vanity_oauth.sql`

```bash
psql $DATABASE_URL < server/db/migrations_pg/011_sprint93_boost_vanity_oauth.sql
```

---

## Discord Parité Güncellemesi

| Özellik | Sprint 92 | Sprint 93 |
|---------|-----------|-----------|
| Boost ekonomisi | 4/10 | 8/10 |
| Vanity URL | 0/10 | 8/10 |
| Sosyal bağlantılar | 5/10 | 8/10 |
| E2EE | 7/10 | 9/10 |
| **Genel** | **~7.8/10** | **~8.5/10** |
