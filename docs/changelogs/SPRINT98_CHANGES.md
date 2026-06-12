# Sprint 98 — Repository Pattern Tamamlama + Versiyon Senkronizasyonu

> **Hedef:** Sprint 97'de ESLint kuralıyla yakalanan kalan `pool.query()` ihlallerini repository katmanına taşımak; versiyon numarasını sprint geçmişiyle senkronize etmek.

---

## 1. 🗄️ `BotMarketplaceRepository` — `addReview()` Metodu

**Dosya:** `server/db/repositories/BotMarketplaceRepository.ts`

### Problem
`bot-marketplace.ts` route'undaki onay log'u (`bot_marketplace_reviews` INSERT) doğrudan `pool.query()` ile yazılıyordu. `BotMarketplaceRepository`'de karşılık gelen metot yoktu.

### Değişiklik
```ts
async addReview(opts: {
  id:         string;
  botId:      string;
  reviewerId: string;
  action:     'approve' | 'reject';
  note:       string;
  createdAt:  number;
}): Promise<void>
```
Repository'ye eklendi; route içindeki `dynamic import('../db/postgres/pool.js')` + `pool.query(...)` kaldırıldı.

---

## 2. 🔗 `OAuthRepository` — `upsertConnection()` Metodu

**Dosya:** `server/db/repositories/OAuthRepository.ts`

### Problem
`spotify-oauth.ts` callback'inde `user_connections` tablosuna yazma `pool.query()` ile yapılıyordu. `"user_connections kendi repository'si henüz yok"` yorumu geçerliliğini yitirmişti — `OAuthRepository` bu tabloyu kapsamalıydı.

### Değişiklik
```ts
async upsertConnection(
  userId:   string,
  platform: string,
  username: string,
  url:      string,
): Promise<void>
```
`OAuthRepository`'ye eklendi; route içindeki `dynamic import` + raw `pool.query(...)` kaldırıldı.

---

## 3. 🏷️ Route Başlık Yorumları — Geçiş Tamamlandı İşareti

Sprint 98 beklenen iş olarak işaretlenmiş tüm route'larda `// Sprint 98: ... geçişi` yorumu `✅` ile güncellendi:

| Route | Durum |
|---|---|
| `server/routes/bot-marketplace.ts` | ✅ |
| `server/routes/spotify-oauth.ts` | ✅ |
| `server/routes/announcement.ts` | ✅ |
| `server/routes/stats.ts` | ✅ |
| `server/routes/boosts.ts` | ✅ |

> **Not:** `upload.ts` içindeki `db.queryOne()` kasıtlı olarak bırakıldı. Bu çağrı raw `pool` değil, `db` abstraction katmanını kullanıyor ve mevcut `eslint-disable-next-line no-restricted-imports` yorumuyla belgelenmiş.

---

## 4. 📦 `package.json` — Versiyon `1.88.0` → `1.97.0`

Sprint 89–97 teslim edilmesine rağmen sürüm güncellenmemişti. Tek adımda 9 sprint'i kapatacak şekilde `1.97.0`'a yükseltildi.

---

## Özet

| Alan | Sprint 97 | Sprint 98 |
|---|---|---|
| `pool.query` ihlali (bot-marketplace review) | ⚠️ Raw SQL | ✅ Repository |
| `pool.query` ihlali (spotify user_connections) | ⚠️ Raw SQL | ✅ Repository |
| `package.json` versiyonu | ⚠️ 1.88.0 (stale) | ✅ 1.97.0 |
| Genel repository pattern uyum | ✅ | ✅ |

## Etkilenen Dosyalar

| Dosya | Değişiklik |
|---|---|
| `server/db/repositories/BotMarketplaceRepository.ts` | `addReview()` eklendi |
| `server/db/repositories/OAuthRepository.ts` | `upsertConnection()` eklendi |
| `server/routes/bot-marketplace.ts` | `pool.query` → `BotMarketplace.addReview()` |
| `server/routes/spotify-oauth.ts` | `pool.query` → `OAuth.upsertConnection()` |
| `server/routes/announcement.ts` | Başlık yorumu ✅ güncellendi |
| `server/routes/stats.ts` | Başlık yorumu ✅ güncellendi |
| `server/routes/boosts.ts` | Başlık yorumu ✅ güncellendi |
| `package.json` | `1.88.0` → `1.97.0` |
| `SPRINT98_CHANGES.md` | Bu dosya |
