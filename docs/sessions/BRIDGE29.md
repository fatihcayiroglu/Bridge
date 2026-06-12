# BRIDGE29 — Sprint 29: Swagger Refactor

**Tarih:** 2026-05-11  
**Durum:** ✅ Tamamlandı

---

## Özet

`server/lib/swagger.ts` (61KB elle yazılmış path stubs) → **swagger-jsdoc otomatik üretim** mimarisine geçiş.  
15 route dosyasına `@openapi` JSDoc annotation eklendi. Toplam **93 endpoint** dokümante edildi.

---

## Değişen Dosyalar

### `server/lib/swagger.ts` — Yeniden yazıldı

**Önceki durum:** Elle yazılmış path nesneleri, her endpoint değiştiğinde manuel güncelleme gerektiriyordu.  
**Yeni durum:** `BASE_SPEC` sadece `components/schemas/tags/servers/security` içeriyor. `paths` tamamen swagger-jsdoc tarafından route JSDoc'larından otomatik üretiliyor.

Değişmeyen kısımlar:
- `BASE_SPEC` schemas: `User`, `Server`, `Channel`, `Message`, `Pagination`
- Yeni eklenen schemas: `Role`, `Thread`, `Poll`
- Yeni eklenen tags: `GroupDM`, `WebAuthn`, `Badges`
- `getSpec()` / `invalidateSpec()` / `swaggerRouter` API — aynı, breaking change yok

### Route dosyaları — `@openapi` JSDoc eklendi

| Dosya | Eklenen endpoint sayısı |
|-------|------------------------|
| `routes/auth.ts` | 14 |
| `routes/messages.ts` | 6 |
| `routes/friends.ts` | 6 |
| `routes/dm.ts` | 3 |
| `routes/groupDm.ts` | 9 |
| `routes/threads.ts` | 9 |
| `routes/polls.ts` | 4 |
| `routes/discover.ts` | 5 |
| `routes/badges.ts` | 4 |
| `routes/upload.ts` | 4 |
| `routes/search.ts` | 2 |
| `routes/twoFactor.ts` | 5 |
| `routes/roles.ts` | 7 |
| `routes/moderation.ts` | 6 |
| `routes/bots.ts` | 5 |
| **TOPLAM** | **93** |

---

## Mimari Karar

### Neden swagger-jsdoc?

Önceki yaklaşım (`swagger.ts` içinde statik `paths: {}`) şu sorunları yaratıyordu:
- Yeni endpoint → `swagger.ts`'te manuel ekleme zorunluluğu
- Route dosyası ile dökümantasyon arasında drift riski
- 61KB tek dosya — okunması ve review'ı zor

Yeni yaklaşım:
- `@openapi` annotation endpoint'in yanında → drift imkânsız
- Yeni route eklendiğinde otomatik Swagger UI'a yansır
- `swagger.ts` sadece `BASE_SPEC` + router orchestration (~170 satır)

### Fallback davranışı (değişmedi)
`swagger-jsdoc` paketi bulunamazsa `BASE_SPEC` (paths: {}) döner — uygulama çökmez.

---

## Kapsam Dışı (Sprint 30+)

Annotate edilmemiş route dosyaları (düşük trafik / internal):

| Dosya | Neden ertelendi |
|-------|-----------------|
| `routes/webauthn.ts` | 7 karmaşık endpoint — ayrı sprint |
| `routes/federation/` | ActivityPub detayları — özel tag seti gerekli |
| `routes/admin/` | Internal — public docs'a girmeyecek |
| `routes/sso.ts` | SSO provider bağımlı — SSO sprint'inde eklenecek |
| `routes/ai/` | Streaming endpoints — SSE dokümantasyonu ayrı |

---

## Test

```bash
# Swagger UI'ın ayakta olduğunu doğrula
curl http://localhost:3000/api/docs/spec.json | jq '.paths | keys | length'
# Beklenen: 90+ path

# Cache yenile (dev modunda)
curl -X POST http://localhost:3000/api/docs/spec/refresh

# Tüm server testleri
cd server && npm test
```

---

## Yeni Dosyalar

```
server/lib/swagger.ts                    — yeniden yazıldı
server/routes/auth.ts                    — @openapi eklendi (14 endpoint)
server/routes/messages.ts               — @openapi eklendi (6 endpoint)
server/routes/friends.ts                — @openapi eklendi (6 endpoint)
server/routes/dm.ts                     — @openapi eklendi (3 endpoint)
server/routes/groupDm.ts               — @openapi eklendi (9 endpoint)
server/routes/threads.ts               — @openapi eklendi (9 endpoint)
server/routes/polls.ts                  — @openapi eklendi (4 endpoint)
server/routes/discover.ts              — @openapi eklendi (5 endpoint)
server/routes/badges.ts                — @openapi eklendi (4 endpoint)
server/routes/upload.ts                — @openapi eklendi (4 endpoint)
server/routes/search.ts                — @openapi eklendi (2 endpoint)
server/routes/twoFactor.ts             — @openapi eklendi (5 endpoint)
server/routes/roles.ts                  — @openapi eklendi (7 endpoint)
server/routes/moderation.ts            — @openapi eklendi (6 endpoint)
server/routes/bots.ts                   — @openapi eklendi (5 endpoint)
docs/sessions/BRIDGE29.md              — bu dosya
```
