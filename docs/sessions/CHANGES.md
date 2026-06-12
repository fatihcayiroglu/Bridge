# Bridge — Bu Oturumda Yapılanlar

## ✅ Tamamlandı

### 1. `migrate-to-postgres.ts` — 12 eksik tablo eklendi
Dosya: `migrate-to-postgres.ts`

Önceki sürümde PostgreSQL schema'sında bulunan ama migration script'inde
eksik olan 12 tablo hem `transforms` objesine hem `MIGRATION_ORDER` listesine eklendi:

- `native_push_tokens` — identity transform
- `notifications` — `read` boolean dönüşümü
- `ap_outgoing_follows` — `accepted` boolean dönüşümü
- `ap_likes` / `ap_announces` — identity
- `ap_delivery_queue` — `payload` JSON parse
- `federation_whitelist` / `federation_blacklist` — identity
- `link_preview_cache` — `data` JSON parse
- `server_templates` — `config` JSON parse + `isBuiltin` boolean
- `podcast_settings` — `enabled` boolean
- `podcast_episodes` — identity

### 2. `postgres.ts` → 3 parçaya bölündü
| Eski | Yeni | Satır |
|------|------|-------|
| `postgres.ts` (1278 satır) | `postgres.ts` (shim, 9 satır) | — |
| — | `postgres/schema.ts` | 425 |
| — | `postgres/collection.ts` | 224 |
| — | `postgres/index.ts` | 640 |

`postgres.ts` sadece `require('./postgres/index')` yapan ince bir shim.
Mevcut tüm `require('./db/postgres')` import'ları değişmeden çalışır.

### 3. `federation.ts` → 4 parçaya bölündü
| Eski | Yeni | Satır |
|------|------|-------|
| `federation.ts` (779 satır) | `federation/index.ts` | 24 |
| — | `federation/peers.ts` | 260 |
| — | `federation/activitypub.ts` | 251 |
| — | `federation/helpers.ts` | 248 |

`federation/index.ts` eski `federation.ts` ile aynı API'yi dışa aktarır:
`module.exports = router` ve `module.exports.deliverToFollowers`.

### 4. `admin.ts` → 4 parçaya bölündü
| Eski | Yeni | Satır |
|------|------|-------|
| `admin.ts` (513 satır) | `admin/index.ts` | 27 |
| — | `admin/core.ts` | 323 |
| — | `admin/federation-acl.ts` | 111 |
| — | `admin/sfu.ts` | 52 |

`admin/index.ts` eski API'yi korur:
`module.exports = router` ve `module.exports.checkFederationACL`.

---

## ✅ Zaten Tamamlanmış (Değişiklik Gerekmedi)
- `node-fetch` → native `fetch` geçişi: Proje zaten `globalThis.fetch` kullanıyor,
  `node-fetch` package.json'da hiç yok. Görev önceden tamamlanmış.
- `.env.example` WebAuthn değişkenleri: `server/.env.example` dosyasında
  `WEBAUTHN_RP_ID`, `WEBAUTHN_RP_NAME`, `WEBAUTHN_ORIGIN` zaten mevcut ve
  varsayılan değerlere sahip.

---

## ⏳ Bu Oturumda Yapılamadı

### Voice/Stage/Music entegrasyon testleri
- Test dosyası yazılabilir ama gerçek çalışan ortam olmadan geçip geçmediği
  doğrulanamaz. `server/tests/stage.test.js` ve `server/tests/music.test.js`
  mevcut — bunlar üzerine inşa edilmeli.

### E2EE DM UI (`client/js/core/e2e.ts`)
- `server/lib/e2e.ts` (anahtar yönetimi) tamam. Client tarafı şifreleme/
  şifre çözme kodu tarayıcıda test edilmeden teslim etmek riskli.
  İlk adım: `client/js/core/dm.ts` içinde `e2e.ts` fonksiyonlarını çağıran
  `sendEncryptedMessage()` + `decryptIncoming()` wrapper'ları.

---

## Kurulum (Bölünmüş Modüller)

Eski dosyaların yerini alacak şekilde kopyala:

```bash
# Bölünmüş federation
cp -r server/routes/federation/  <proje>/server/routes/
# Eski tek dosyayı sil (artık index.ts ile değiştirildi)
# rm <proje>/server/routes/federation.ts  ← opsiyonel; index.ts önce gelir

# Bölünmüş admin
cp -r server/routes/admin/  <proje>/server/routes/

# Bölünmüş postgres
cp server/db/postgres.ts    <proje>/server/db/
cp -r server/db/postgres/   <proje>/server/db/

# Güncellenmiş migration
cp migrate-to-postgres.ts   <proje>/server/db/
```

setupRoutes.ts'de hiçbir şeyin değişmesine gerek yok —
`require('./routes/admin')` ve `require('./routes/federation')`
index.ts'yi otomatik bulur.
