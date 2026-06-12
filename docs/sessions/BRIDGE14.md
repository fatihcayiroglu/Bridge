# BRIDGE — Session 10 Değişiklik Notları

**Tarih:** Mayıs 2026  
**Oturumlar:** Oturum 2 (Sosyal Özellikler) + Oturum 3 (Keşif Güçlendirmesi)

---

## Yeni Dosyalar

| Dosya | Açıklama |
|-------|----------|
| `server/routes/badges.ts` | Rozet API'si (verme, geri alma, katalog, auto-check) |
| `server/socket/handlers/discover.ts` | Gerçek zamanlı üye sayısı push (Socket.IO) |
| `client/js/core/discover.js` | Keşif sayfası istemci — öne çıkan, kategori, realtime |
| `client/js/core/badges.js` | Rozet render, profil entegrasyonu, admin panel |
| `server/tests/badges.test.js` | Rozet sistemi Jest testleri |
| `server/tests/discover2.test.js` | Keşif güçlendirme Jest testleri |
| `server/db/migrations_pg/005_session10_social_discover.sql` | PostgreSQL migration |
| `server/db/sqlite/migrations/004_session10_social_discover.sql` | SQLite migration |

## Değiştirilen Dosyalar

| Dosya | Değişiklik |
|-------|-----------|
| `server/routes/discover.ts` | Kategori filtresi, öne çıkan endpoint, admin feature, `category` alanı |

---

## Oturum 2 — Sosyal Özellikler

### Gelişmiş Kullanıcı Profili

Mevcut `user-connections.js` ve `userConnections.ts` üzerinde değişiklik yapılmadı — bunlar Session 9'dan itibaren tam işlevsel. Session 10 bunların üzerine **rozet sistemi** ekler.

### Rozet Sistemi (`badges.ts` + `badges.js`)

**API Endpoint'leri:**

```
GET  /api/users/:userId/badges        — kullanıcı rozetleri (public)
GET  /api/badges/definitions          — rozet kataloğu
POST /api/admin/badges/award          — admin: rozet ver
DELETE /api/admin/badges/revoke       — admin: rozet geri al
```

**Rozet türleri:**

| Badge key | İkon | Tür | Nasıl kazanılır |
|-----------|------|-----|-----------------|
| `early_adopter` | 🌱 | Manual | Admin tarafından |
| `one_year` | 🎂 | Otomatik | 365 gün kullanım |
| `two_years` | 🎉 | Otomatik | 730 gün kullanım |
| `connector` | 🔗 | Otomatik | 3+ platform bağlantısı |
| `server_founder` | 🏛️ | Otomatik | Sunucu kurucusu |
| `bot_developer` | 🤖 | Otomatik | Bot API anahtarı oluşturdu |
| `verified` | ✅ | Manual | Admin onayı |
| `contributor` | 💎 | Manual | Katkıda bulunan |
| `moderator` | 🛡️ | Manual | Güvenilir moderatör |
| `bug_hunter` | 🐛 | Manual | Kritik hata bildirimi |

**Auto-check:**  
`checkAndAwardAutoBadges(userId)` fonksiyonu giriş ve profil güncellemesi sonrası çağrılmalı.  
Hangi auth/users route'una ekleneceğini aşağıda görebilirsiniz.

**Auth route entegrasyonu** (`server/routes/auth.ts` içine eklenecek):
```js
const { checkAndAwardAutoBadges } = require('./badges');

// Login success handler'ın sonuna:
await checkAndAwardAutoBadges(user.id).catch(() => {});
```

**İstemci profil entegrasyonu:**
```js
// Profil hover kartı açılırken:
await window.injectBadgesIntoProfileCard(userId, profileCardElement);
```

---

## Oturum 3 — Keşif Güçlendirmesi

### Öne Çıkan Sunucular

**GET /api/discover/featured**  
- Admin tarafından haftalık seçilen sunucuları döndürür  
- Cache TTL: 5 dakika (Redis)  
- Max 12 sunucu  
- Her sunucu `featured: true` ve `featuredAt` alanını içerir

**Admin endpoint:**
```
POST /api/admin/discover/feature
Body: { serverId, featured: true/false }
```

### Kategori Bazlı Gezinme

**GET /api/discover/categories** — Kategori listesi  
**GET /api/discover?category=gaming** — Kategoriye göre filtrele

Desteklenen kategoriler: `gaming`, `music`, `art`, `tech`, `edu`, `social`, `other`

**Sunucu ayarları güncellemesi:**
```
PATCH /api/discover/settings
Body: { serverId, category: "gaming" }
```

### Gerçek Zamanlı Üye Sayısı (Socket.IO)

**Akış:**
```
Client                          Server
  |─ discover:subscribe ──────▶ |  (keşif sayfası açıldı)
  |                             |  Member join/leave
  |◀─ discover:memberCount ───── |  { serverId, memberCount, onlineCount, ts }
  |─ discover:unsubscribe ────▶ |  (keşif sayfasından ayrıldı)
```

**Sunucu entegrasyonu** (`server/socket/index.ts` içine eklenecek):
```ts
const { registerDiscoverHandlers } = require('./handlers/discover');

io.on('connection', (socket) => {
  registerDiscoverHandlers(io, socket);
  // ... diğer handler'lar
});
```

**Üye değişikliğinde push** (`infra.ts` veya members socket handler'ında):
```ts
const { pushMemberCount } = require('./handlers/discover');

// Üye katıldığında / ayrıldığında:
await pushMemberCount(io, serverId);
```

**İstemci:** `client/js/core/discover.js`  
- `onDiscoverMount()` → sayfa açıldığında çağrılır  
- `onDiscoverUnmount()` → sayfa kapatıldığında çağrılır (socket unsubscribe)  
- Kart DOM'u socket event'te minimal güncellenmiştir (tam re-render yok)

---

## Migration Çalıştırma

```bash
# PostgreSQL
psql -d bridge -f server/db/migrations_pg/005_session10_social_discover.sql

# SQLite (migration sistemi otomatik çalıştırır)
# Manuel: sqlite3 bridge.db < server/db/sqlite/migrations/004_session10_social_discover.sql
```

---

## Testler

```bash
# Sadece yeni testler
npx jest badges discover2 --forceExit

# Tüm testler
npm test
```
