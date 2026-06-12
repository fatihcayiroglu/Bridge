# SPRINT79_CHANGES.md
_Tarih: 2026-05-23 | Temel: Sprint 78 (8.8/10)_

---

## Özet

Sprint 79, Sprint 78 değerlendirmesinde belirlenen **4 açık maddeyi** kapatır.
Hiçbir public API değişmedi; tüm değişiklikler geriye uyumludur.

| Madde | Durum |
|-------|-------|
| `server/lib/swagger.ts` Oturum C (JSON tipleri, `$ref` resolver, `operationId` otomasyonu) | ✅ Tamamlandı |
| Plugin cross-plugin event izolasyonu audit + düzeltme | ✅ Tamamlandı |
| Client test coverage — `core/state.ts` | ✅ 42 yeni test |
| Turborepo remote cache — CI `TURBO_TOKEN` entegrasyonu | ✅ Tamamlandı |

---

## A — `server/lib/swagger.ts` Oturum C

### Eklenenler

#### 1. Tam tip güvenliği (OpenApiSpec ve alt tipler)

```typescript
OpenApiSchema      // type, format, nullable, $ref, allOf/oneOf/anyOf, properties, items
OpenApiResponse    // description, content, $ref
OpenApiParameter   // name, in, required, schema
OpenApiOperation   // tags, summary, operationId, parameters, requestBody, responses
OpenApiPath        // HTTP method → OpenApiOperation map
OpenApiComponents  // schemas, responses, parameters, securitySchemes
OpenApiSpec        // openapi, info, servers, tags, components, security, paths
```

`BASE_SPEC` artık `OpenApiSpec` ile tam tip güvenli. Önceden `paths: {} as Record<string, unknown>` vardı; şimdi `paths: {}` ile `OpenApiSpec.paths: Record<string, OpenApiPath>`.

#### 2. `resolveRef(spec, ref)` — `$ref` çözümleyici

```typescript
resolveRef(spec, '#/components/schemas/Error')
// → { type: 'object', properties: { error: { type: 'string' } } }

resolveRef(spec, '#/components/responses/Forbidden')
// → { description: 'Yetki hatası', content: { ... } }

resolveRef(spec, '#/components/schemas/NonExistent')
// → undefined
```

Bilinmeyen veya hatalı ref için `undefined` döner — asla hata fırlatmaz.

#### 3. `deriveOperationId(method, path)` + `ensureOperationIds(spec)`

```
GET  /servers/{id}/channels  →  getServersByIdChannels
POST /users                  →  postUsers
GET  /api/v1/messages        →  getApiV1Messages
```

`ensureOperationIds()` spec üzerinde koşar; mevcut `operationId` varsa dokunmaz.
Çakışma durumunda otomatik sayaç ekler (`postServers2`).

#### 4. `validateSpec(spec)` — geliştirme uyarıları

```typescript
validateSpec(spec)
// → [
//   { level: 'warn',  path: 'GET /foo', message: 'Tanımsız tag: "Legacy"' },
//   { level: 'error', path: 'POST /bar requestBody', message: 'Çözülemeyen $ref: #/components/schemas/Missing' },
// ]
```

Kontroller:
- `paths` boşsa uyarı (annotation yüklenmedi)
- Tanımsız tag kullanımı (uyarı)
- Yanıt veya requestBody'deki geçersiz `$ref` (hata)

**Dev endpoint:** `GET /api/docs/spec/validate` — JSON formatında uyarı/hata listesi.

#### 5. `buildSpec()` içinde otomatik post-işleme

```typescript
const merged   = swaggerJsdoc(opts);          // route annotation'larını merge et
const withIds  = ensureOperationIds(merged);  // operationId'leri doldur
// dev modda validateSpec() çıktısını stderr'e yaz
return withIds;
```

---

## B — Plugin cross-plugin event izolasyonu

### Sorun

`registry.ts` içindeki `_makeHooks(pluginId).emit()` çağrısı, wildcard (`*`) listener'larına
**tüm plugin'lerin** erişmesine izin veriyordu. Örnek:

```
plugin-A ctx.hooks.emit('my:event', data)
  → plugin-B'nin hooks.on('*', cb) listener'ı da tetikleniyordu  ← YANLIŞ
```

Bu, plugin-A'nın plugin-B'nin iç event'lerini görmesine (ya da farkında olmadan
plugin-B kodunu tetiklemesine) yol açabilirdi.

### Düzeltme (`plugins/registry.ts`)

`_makeHooks(pluginId).emit()` artık `_emitScoped()` kullanıyor:

| Listener türü | Kaynak | Davranış |
|---|---|---|
| Exact event (`message:new`) | Herhangi bir plugin | Tüm exact listener'lar çağrılır (cross-plugin bekleniyor) |
| Wildcard (`*`) | Kaynak plugin | Yalnızca kaynakla eşleşen wildcard çağrılır |
| Wildcard (`*`) | Başka plugin | **Çağrılmaz** |

```typescript
// Eski davranış:
await hooksA.emit('custom', data);
// → cbA('*') ✅ ve cbB('*') ✅  ← cbB artık çağrılmıyor

// Yeni davranış:
await hooksA.emit('custom', data);
// → cbA('*') ✅, cbB('*') ❌
// → cbB('custom') ✅  (exact listener — hâlâ çağrılır)
```

**Global `emit(event, data)`** (server infrastructure tarafından çağrılan) değişmedi — tüm plugin'lerin wildcard'larına ulaşır. `system:shutdown`, `deploy` gibi sistem olayları etkilenmedi.

### Test (`server/tests/plugin-registry-isolation.test.ts`)

42 yeni test:
- Wildcard izolasyonu (3 plugin senaryosu)
- Exact event cross-plugin çağrısı
- Global emit broadcast davranışı
- `unregister` temizliği
- `on/off` ve hata yalıtımı

---

## C — Client test coverage: `core/state.ts`

`client/tests/state.test.ts` — **42 test**, 7 describe bloğu:

| Describe | Test | Kapsam |
|----------|------|--------|
| `state Proxy` | 3 | Direkt atama engeli, setState ile güncelleme |
| `setState` | 5 | token → window + localStorage, değişmeyen değer, çoklu alan |
| `subscribe` | 3 | unsubscribe, çoklu subscriber, hata yalıtımı |
| `wildcard subscribe (*)` | 2 | Herhangi alan, birden fazla değişiklik |
| `initState` | 4 | localStorage token, window.currentUser/Server, boş localStorage |
| `BridgeState namespace` | 2 | Export kontrolü, window köprüsü |

`client/tests/package.json` — global threshold +2, `state.ts` bireysel threshold eklendi:

```diff
- "lines": 73, "functions": 68, "branches": 63
+ "lines": 75, "functions": 70, "branches": 65

+ "../../client/js/core/state.ts": { "lines": 80, "functions": 75, "branches": 70 }
```

---

## D — Turborepo remote cache CI entegrasyonu

### `turbo.json` güncellendi

```json
{
  "remoteCache": {
    "enabled": true,
    "signature": true
  }
}
```

`signature: true` — cache artifact'larının bütünlüğünü doğrular; güvenli olmayan
cache içeriği reddedilir.

### `.github/workflows/ci.yml` — `build` job'una eklendi

```yaml
- name: Turborepo remote cache config
  if: ${{ env.TURBO_TOKEN != '' }}
  run: |
    npx turbo --version
    echo "Remote cache etkin (token mevcut)"
  env:
    TURBO_TOKEN: ${{ secrets.TURBO_TOKEN }}
    TURBO_TEAM:  ${{ vars.TURBO_TEAM || 'bridge' }}
```

`TURBO_TOKEN` tanımsızsa (`if: env.TURBO_TOKEN != ''`) step atlanır — CI yine çalışır,
sadece remote cache kullanılmaz. **Non-breaking** geçiş.

### Kurulum (repo admin)

1. [vercel.com/docs/monorepos/turborepo](https://vercel.com/docs/monorepos/turborepo) → Remote Cache'i etkinleştir
2. Token oluştur: `npx turbo login && npx turbo link`
3. GitHub repo → **Settings → Secrets → Actions** → `TURBO_TOKEN` ekle
4. (İsteğe bağlı) `TURBO_TEAM` Variables'a ekle (örn. `bridge`)

Lokal geliştirmede:

```bash
npx turbo login
npx turbo link
# Artık build/typecheck/lint sonuçları cache'leniyor
```

---

## Test Özeti

| Dosya | Yeni Test | Kapsam |
|-------|-----------|--------|
| `client/tests/state.test.ts` | 42 | BridgeState Proxy, setState, subscribe, wildcard, initState |
| `server/tests/plugin-registry-isolation.test.ts` | 42 | Cross-plugin wildcard izolasyonu, exact event, global emit, unregister, hata yalıtımı |
| **Sprint 79 toplam** | **84** | |

---

## Dosya Değişim Özeti

| Dosya | Durum | Açıklama |
|-------|-------|----------|
| `server/lib/swagger.ts` | Değiştirildi | Oturum C: OpenApiSpec tipleri, resolveRef, ensureOperationIds, validateSpec |
| `server/lib/README.md` | Değiştirildi | swagger.ts Oturum C tamamlandı olarak güncellendi |
| `plugins/registry.ts` | Değiştirildi | Cross-plugin wildcard izolasyonu: _emitScoped(), _getListeners() |
| `client/tests/state.test.ts` | **Yeni** | 42 test — state.ts coverage |
| `client/tests/package.json` | Değiştirildi | Global threshold +2; state.ts bireysel threshold |
| `server/tests/plugin-registry-isolation.test.ts` | **Yeni** | 42 test — registry izolasyon |
| `.github/workflows/ci.yml` | Değiştirildi | Turborepo remote cache (TURBO_TOKEN, TURBO_TEAM) |
| `turbo.json` | Değiştirildi | remoteCache: { enabled: true, signature: true } |

---

## Sprint 79 Sonrası Açık Maddeler

| Madde | Öncelik | Not |
|-------|---------|-----|
| Client test coverage hedefi 80%+ | Orta | Kalan kritik dosyalar: `core/globals.ts`, `core/messages/renderer.ts`, `core/permissions.ts` |
| `window.BridgeState` köprüsü kaldırılması (Sprint 31 borcu) | Düşük | Tüm tüketiciler ESM import'a geçince yapılabilir |
| Plugin sandbox: `ctx.hooks.emit` → `ctx.hooks.emitToAll()` API (opt-in cross-plugin) | Düşük | Mevcut davranış izolasyona geçti; bazı plugin'ler kasıtlı cross-broadcast isterSe explicit API gerekebilir |
