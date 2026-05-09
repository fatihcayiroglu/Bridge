# Bridge API Versioning Stratejisi

## Mevcut Durum

`setupRoutes.js`'deki `mountApi` fonksiyonu her route'u hem `/api/...` hem de `/api/v1/...`'e mount ediyor:

```js
const mountApi = (suffix, router) => {
  app.use(`/api${suffix}`, router);
  app.use(`/api/v1${suffix}`, router);
};
```

Bu yaklaşım **şimdilik işe yarıyor** ama v2 geldiğinde ciddi sorunlar çıkaracak:
- `/api/...` hangi versiyonun "canonical" olduğu belirsiz
- v2 route'ları eklenince aynı path'te iki handler çakışır
- İstemciler hangi versiyonu çağırdığını bilemez

---

## Strateji: Semver Prefix + Deprecation Window

### İlke

| Durum | URL |
|---|---|
| **Stabil, aktif** | `/api/v1/...` |
| **Yeni versiyon** | `/api/v2/...` |
| **Versionless** (geriye dönük uyumluluk) | `/api/...` → v1'e yönlendir (301 değil, proxy) |
| **Deprecated** | Header ile bildir, 6 ay sonra kaldır |

### Geçiş Planı

**Sprint 8 (şimdi):** `mountApi` davranışını koruyoruz, ama `/api/...` artık açıkça "v1 alias" olarak dokümante edildi.

**Sprint 10:** `v2` route'ları gelmeye başladığında `mountApi` şöyle değişir:

```js
// YENİ mountApi — v1 canonical, versionless = v1 alias
const mountApi = (suffix, router, opts = {}) => {
  const { v2: v2router, deprecated } = opts;

  // v1 — canonical
  app.use(`/api/v1${suffix}`, router);

  // versionless — v1'e alias (deprecated header ekle)
  app.use(`/api${suffix}`, (req, res, next) => {
    if (deprecated) {
      res.setHeader('Deprecation', 'true');
      res.setHeader('Sunset', deprecated); // "Sat, 1 Jan 2027 00:00:00 GMT"
      res.setHeader('Link', `</api/v1${req.path}>; rel="successor-version"`);
    }
    return router(req, res, next);
  });

  // v2 — yeni davranış varsa
  if (v2router) {
    app.use(`/api/v2${suffix}`, v2router);
  }
};
```

**Sprint 12:** `/api/...` endpoint'leri `Deprecation: true` header'ı taşır. SDK'lar uyarı log'lar.

**Sprint 16+:** `/api/...` (versionless) kaldırılır.

---

## Deprecation Header Standardı

RFC 8594 ve IETF draft'a uygun:

```
Deprecation: true
Sunset: Sat, 01 Jan 2027 00:00:00 GMT
Link: </api/v1/servers>; rel="successor-version"
```

İstemci SDK'sı bu header'ları görmeli ve development modunda console.warn basmalı.

---

## Versiyonlar Arası Değişiklik Kuralları

### Non-breaking (aynı versiyonda kabul edilir):
- Yeni optional field ekleme (response'a)
- Yeni endpoint ekleme
- Hata mesajı metni değişikliği (kod değil)

### Breaking (yeni versiyon gerektirir):
- Field kaldırma veya rename
- Required field ekleme (request'e)
- HTTP status kodu değişikliği
- Auth davranışı değişikliği
- Pagination davranışı değişikliği

---

## v1 → v2 Geçiş Senaryosu (Örnek)

v2'de `GET /api/v2/channels/:id/messages` cursor tabanlı yerine `nextCursor` döneceğini varsayalım:

```js
// routes/messages.v2.js — sadece değişen endpoint'ler
const router = express.Router();

router.get('/:cid/messages', auth, async (req, res) => {
  // Yeni cursor formatı
  const { data, nextCursor } = await Messages.findByChannelCursor(req.params.cid, req.query);
  res.json({ data, nextCursor, version: 2 });
});

module.exports = router;

// setupRoutes.js'de:
mountApi('/channels', messagesRouter, { v2: messagesV2Router });
```

v1 çalışmaya devam eder, v2 paralel çalışır, istemciler kendi hızında geçiş yapar.

---

## Şimdi Yapılması Gerekenler

1. ✅ Bu belgeyi ekip ile paylaş
2. ✅ `swagger.js`'e `servers` listesine v1 ekle (şu an sadece `/api` var)
3. ⬜ OpenAPI spec'te her endpoint için `x-api-version: "1"` tag'i ekle
4. ⬜ Discord Shim (`discord-shim/`) hangi versiyonu hedef aldığını dokümante et
5. ⬜ Sprint 10'da `mountApi`'yi yukarıdaki yeni versiyona geçir

---

## swagger.js Düzeltmesi

`lib/swagger.js`'deki `servers` array'ine v1 canonical URL'i ekle:

```js
servers: [
  { url: '/api/v1', description: 'v1 — stabil, önerilen' },
  { url: '/api',    description: 'v1 alias — deprecated olacak (Sprint 16)' },
],
```
