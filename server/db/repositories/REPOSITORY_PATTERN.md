# Repository Pattern — Sürdürülebilirlik Modeli

## Neden Repository Pattern?

Önceki durumda `db.users.findOne(...)`, `db.channels.find(...)` gibi ham koleksiyon
çağrıları 40+ route ve socket handler dosyasına yayılmıştı (routes/: **793**, socket/handlers/: **42** direkt `db.*` çağrısı).
Bu durum şu sorunlara yol açıyordu:

| Sorun | Etki |
|---|---|
| Aynı sorgu mantığı birden fazla yerde tekrarlanıyor | Bug fix yapınca hepsini bulmak zorunda kalıyorsunuz |
| DB katmanı değiştiğinde (SQLite → PG) her dosyayı güncellemek gerekiyor | Yüksek değişiklik riski |
| Test yazarken `db` nesnesini mock'lamak zorlaşıyor | `jest.mock('../db/loader')` tek mock değil |
| İş mantığı (zaman aşımı kontrolü, rol serialize) route'larda dağılmış | Tutarsız davranış |

---

## Mimari

```
routes/         ──→  repositories/   ──→  db/loader   ──→  PostgreSQL
socket/handlers/      (tek erişim                          (veya SQLite)
                       noktası)
```

### Repository Katmanı

`server/db/repositories/` altında her domain için bir sınıf:

| Repository | Sorumluluk | Örnek metodlar |
|---|---|---|
| `UserRepository` | Kullanıcı CRUD | `findById`, `findByUsername`, `setStatus` |
| `ServerRepository` | Sunucu + üyelik | `findJoinedByUser`, `addMember` |
| `MessageRepository` | Mesaj sorgulama | `findByChannel`, `findLastTimestamps` |
| `ChannelRepository` | Kanal + kategori | `findByServer`, `insertCategory`, `unlinkCategory` |
| `MemberRepository` | Üyelik CRUD | `findOne(userId, serverId)`, `setRoles` |
| `InviteRepository` | Davet kodu | `findByCode`, `isValid()`, `create()` |
| `RoleRepository` | Rol CRUD | `findByServer`, `findByIdAndServer` |
| `DmRepository` | DM konuşma + mesaj | `findOrCreateConversation`, `findMessages` |
| `GroupDmRepository` | Grup DM full | `addMember`, `transferOwnership`, `deleteGroup` |
| `BotRepository` | Bot + rating | `findByIdAndToken`, `addToServer` |
| `ThreadRepository` | Thread + mesaj | `deleteThread` (cascade) |
| `AutomodRepository` | Otomod kuralları | `findByServer`, `count` |
| `ReactionRoleRepository` | Reaksiyon rolleri | `findDuplicate`, `findByMessageAndEmoji` |
| `ScheduledMessageRepository` | Zamanlı mesaj | `findPending`, `markSent` |
| `NotificationRepository` | Push + pref | `upsertNativeToken`, `upsertPref` |
| `SocialRepository` | Arkadaşlık + blok | `findFriendship`, `insertBlock` |
| `ServerAssetRepository` | Emoji/gif/sound | `upsertOnboarding`, `markOnboardingComplete` |
| `AuthRepository` | Token + WebAuthn | `revokeAllForUser`, `findCredentialsByUser` |
| `OutgoingWebhookRepository` | Webhook CRUD | `findActive` |
| `PollRepository` | Anket CRUD | `findByChannel` |

---

## Kullanım

```js
// ÖNCE (doğrudan db erişimi)
const db = require('../db/loader');
const membership = await db.members.findOne({ userId: req.user.id, serverId });
const rules = await db.reactionRoles.find({ serverId: sid });

// SONRA (repository aracılığıyla)
const { Members, ReactionRoles } = require('../db/repositories');
const membership = await Members.findOne(req.user.id, serverId);
const rules = await ReactionRoles.findByServer(sid);
```

---

## Yeni Route Yazarken Kurallar

1. **`db/loader` require'ı yasak** — route ve socket dosyalarında `const db = require('../db/loader')` yazamazsınız.
2. **Repository import edin** — `const { Users, Channels } = require('../db/repositories')`.
3. **Repository metodları yeterli değilse** — önce ilgili repository'e yeni bir metod ekleyin, sonra kullanın.
4. **Ham koleksiyon erişimi gerekiyorsa** — sadece `db/repositories/*.js` içinde olabilir.

### ESLint kuralı (öneri)

```js
// eslint.config.js — route ve handler klasörleri için
{
  files: ['server/routes/**', 'server/socket/handlers/**'],
  rules: {
    'no-restricted-imports': ['error', {
      patterns: [{ group: ['**/db/loader', '**/db/index'], message: 'Use repositories instead: require("../db/repositories")' }]
    }]
  }
}
```

---

## Migration Planı

Mevcut route'ları repository'ye geçirmek için öncelik sırası (direkt `db.*` sayısına göre):

| Öncelik | Dosya | db.* sayısı | Hedef Repo |
|---|---|---|---|
| 1 | `routes/servers.js` | 52 | Servers, Members, Channels, Invites |
| 2 | `routes/admin.js` | 47 | Users, Servers, Messages, Auth |
| 3 | `routes/groupDm.js` | 40 | GroupDms |
| 4 | `routes/webauthn.js` | 33 | Auth, Users |
| 5 | `routes/threads.js` | 30 | Threads, Members |
| 6 | `routes/bots.js` | 29 | Bots |
| 7 | `socket/handlers/messages.js` | 26 | Messages, Members, Channels, ReactionRoles |
| 8 | `routes/auth.js` | 19 | Users, Auth |
| 9 | `socket/handlers/dm.js` | 14 | Dms, Users |
| ✅ | `routes/categories.js` | — | **Tamamlandı** |
| ✅ | `routes/reactionRoles.js` | — | **Tamamlandı** |

---

## Test Stratejisi

Repository pattern'i benimsemek mock'lamayı basitleştirir:

```js
// Eski yaklaşım — db modülünü tamamen mock'lamak gerekiyordu
jest.mock('../db/loader', () => ({ users: { findOne: jest.fn() }, ... }));

// Yeni yaklaşım — sadece ilgili repository'i mock'layın
jest.mock('../db/repositories', () => ({
  Members: { findOne: jest.fn().mockResolvedValue({ userId: 'u1', serverId: 's1' }) },
  ReactionRoles: { findByServer: jest.fn().mockResolvedValue([]) },
}));
```

---

## Sürdürülebilirlik İlkeleri

- **Tek Sorumluluk**: Her repository yalnızca kendi domain'ini yönetir. `MessageRepository` üye sorgusu yapmaz.
- **Yöntem İsimlendirme**: `findBy<Field>`, `insert`, `update`, `delete`, `count` — tutarlı prefix.
- **Optional chaining**: `db.serverGifs?.remove(...)` — feature-flag koleksiyonları için güvenli.
- **Cascade metodları**: `deleteThread()`, `deleteGroup()` gibi ilgili tablo silmelerini içine alan metodlar repository içinde kalır, route'da dağılmaz.
- **Doğrulama yok**: Repository'ler sadece DB işlemi yapar. Input validasyon route'da, iş kuralı validasyonu route/middleware'da kalır.
