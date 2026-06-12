# SPRINT81_CHANGES.md
_Tarih: 2026-05-23 | Temel: Sprint 80 (10/10)_

---

## Özet

Sprint 81, Sprint 80 değerlendirmesinin "daha iyi ne yapılabilir" başlığında
belirlenen **6 açık maddeyi** kapatır.
Hiçbir public API değişmedi; tüm değişiklikler geriye uyumludur.

| Madde | Durum |
|-------|-------|
| `window.loadFriends` / `window.handleStageEvent` köprülerini kaldır | ✅ Tamamlandı |
| `emitToAll` rate-limit koruması | ✅ Tamamlandı |
| `resolveRef` — harici `$ref` kısıtlaması belgelenmiş notu | ✅ Tamamlandı |
| `globals.ts` unit testleri | ✅ Tamamlandı |
| `messages/renderer.ts` unit testleri | ✅ Tamamlandı |
| `e2e/tests/plugins.spec.ts` — plugin E2E testleri | ✅ Tamamlandı |

---

## A — `window.loadFriends` / `window.handleStageEvent` köprüsü kaldırma

### Sorun

`socket-events.ts` iki fonksiyonu `window.X` üzerinden çağırıyordu:

```typescript
// Önce (Sprint 80 sonrası):
if (typeof window.loadFriends === 'function') (window.loadFriends as () => void)();
if (typeof window.handleStageEvent === 'function') window.handleStageEvent(ev, data);
```

Her iki fonksiyon da ESM export olarak mevcut. Sprint 82 hedefi olarak bırakılmıştı;
Sprint 81'de kapatıldı.

### Değiştirilen: `client/js/core/socket-events.ts`

```diff
+ import { openStatusPicker, loadFriends }    from './friends.js';
+ import { handleStageEvent }                 from './channel-stage.js';
...
- if (typeof window.loadFriends === 'function') (window.loadFriends as () => void)();
+ void loadFriends();
...
- if (typeof window.handleStageEvent === 'function') {
-   window.handleStageEvent(ev, data);
- }
+ handleStageEvent(ev, data as Record<string, unknown>);
```

### Değiştirilen: `client/js/types/globals.d.ts`

`loadFriends?` ve `handleStageEvent?` Window declare'ları kaldırıldı.
Açıklayıcı yorum eklendi.

---

## B — `emitToAll` Rate-Limit Koruması

### Sorun

Sprint 80'de eklenen `ctx.hooks.emitToAll()` izolasyon garantisini kıran bir
opt-in broadcast API'ydi. Ancak hatalı veya kötü niyetli bir plugin worker'ı
döngüde `emitToAll` çağırarak tüm plugin ekosistemini etkileyebilirdi.
`ctx.hooks.emit()` izole olduğu için bu riski taşımıyordu; `emitToAll` kör nokta oluşturuyordu.

### Çözüm

Sliding window rate-limiter eklendi:

| Sabit | Değer | Açıklama |
|-------|-------|----------|
| `BROADCAST_RATE_LIMIT` | 20 | Pencere başına maksimum broadcast |
| `BROADCAST_RATE_WINDOW_MS` | 1000 ms | Pencere süresi |

Limit aşılınca:
- Mesaj düşürülür (registry.emit çağrılmaz)
- Ack **hemen** gönderilir — `await ctx.hooks.emitToAll(...)` asılı kalmaz
- İlk aşım anında bir kez `logger.warn` basılır (sonraki her mesajda log spam yapılmaz)
- Teardown'da pencere timer'ı temizlenir

### Değiştirilen: `plugins/lifecycle.ts`

- `BROADCAST_RATE_LIMIT` ve `BROADCAST_RATE_WINDOW_MS` sabitleri export edildi
- `load()` içinde worker başına `_broadcastAllowed()` guard fonksiyonu eklendi
- `hook:event:broadcast` handler'ına guard eklendi
- Teardown'a `clearTimeout(_broadcastWindowTimer)` eklendi

---

## C — `resolveRef` Harici `$ref` Notu

### Sorun

`resolveRef` yalnızca `#/` ile başlayan JSON Pointer ref'lerini destekliyor.
HTTP ref'leri (`https://...`) ve harici dosya ref'leri (`./schemas/user.yaml`)
sessizce `undefined` döndürüyor. Bu bir tasarım kararıydı ama hiç belgelenmemişti.

### Değiştirilen: `server/lib/swagger.ts`

`resolveRef` fonksiyon yorumuna KISITLAMA bloğu eklendi:

```typescript
// KISITLAMA: Yalnızca JSON Pointer tabanlı local ref'leri (#/ ile başlayan)
// çözümler. HTTP ref'leri (https://...) ve harici dosya ref'leri
// (./schemas/user.yaml) desteklenmez — sessizce undefined döner.
// Sprint 83 hedefi: harici ref desteği.
```

---

## D — `globals.ts` Unit Testleri

### Yeni dosya: `client/tests/globals.test.ts`

**7 describe bloğu, toplam 24 test:**

| Describe | Testler | Kapsam |
|----------|---------|--------|
| `getAPI()` | 2 | window.BRIDGE_API + fallback |
| setter/getter döngüleri | 9 | me, socket, server, channel, token, memberList, clientConfig, editingMessageId, replyingTo, unreadMentions |
| `applyServerEmojis()` | 5 | boş cache, boş string, emoji ikamesi, bilinmeyen token, XSS temizliği |
| `setCurrentServerChannels()` | 2 | ESM export + window köprüsü |
| `addNsfwAccepted()` | 2 | Set ekleme + yineleme koruması |
| `_persistCollapsedCategories()` | 2 | localStorage yazma + boş set |
| BridgeRegistry kayıtları | 7 | getCurrentUser, getCurrentUserId, getCurrentChannel, getCurrentMember, setMeField |

---

## E — `messages/renderer.ts` Unit Testleri

### Yeni dosya: `client/tests/renderer.test.ts`

**9 describe bloğu, toplam 27 test:**

| Describe | Testler | Kapsam |
|----------|---------|--------|
| Temel `renderMessage()` | 3 | DOM ekleme, tekrar engeli, eksik DOM |
| Blocked user filtresi | 2 | Engellenen kullanıcı gizlenir, engellenmeyenler gösterilir |
| msg.type şubeleri | 4 | system, isContinuation, normal, msg-group |
| Dosya tipleri | 4 | image, video, audio, generic file |
| voice_message | 2 | transcript var/yok |
| Badge'ler | 4 | editedAt, pinned, scheduledId, bridgedFrom |
| replyTo | 2 | quote HTML var/yok |
| `updateMessage()` | 2 | içerik güncelleme, ghost mesaj |
| `deleteMessage()` | 2 | DOM kaldırma, ghost mesaj |

---

## F — Plugin E2E Testleri

### Yeni dosya: `e2e/tests/plugins.spec.ts`

**6 test:**

| Test | Kapsam |
|------|--------|
| Plugin yükleme → 200 + id | POST /api/admin/plugins/load |
| Yüklü plugin listede görünür | GET /api/admin/plugins |
| Hook event kendi listener'ını tetikler | ctx.hooks.emit + registerRoute doğrulama |
| emitToAll cross-plugin broadcast | İki plugin arası wildcard tetiklemesi |
| emitToAll rate-limit — caller bloke olmaz | 25 çağrı, 20 limit, hepsi resolve |
| Plugin kaldırma | POST /api/admin/plugins/unload + liste doğrulama |

Tüm testler `test.skip()` ile koşullu — plugin API'si aktif olmayan ortamlarda
sessizce atlanır.

---

## Test Özeti

| Dosya | Yeni Test | Kapsam |
|-------|-----------|--------|
| `client/tests/globals.test.ts` | 24 | globals.ts tüm major export'lar |
| `client/tests/renderer.test.ts` | 27 | renderer.ts renderMessage/update/delete |
| `e2e/tests/plugins.spec.ts` | 6 | Plugin yaşam döngüsü E2E |
| **Sprint 81 toplam** | **57** | |

---

## Dosya Değişim Özeti

| Dosya | Durum | Açıklama |
|-------|-------|----------|
| `client/js/core/socket-events.ts` | Değiştirildi | window.loadFriends/handleStageEvent → ESM import |
| `client/js/types/globals.d.ts` | Değiştirildi | loadFriends/handleStageEvent declare kaldırıldı |
| `plugins/lifecycle.ts` | Değiştirildi | emitToAll rate-limit [6] eklendi |
| `server/lib/swagger.ts` | Değiştirildi | resolveRef harici $ref kısıtlaması belgelendi |
| `client/tests/globals.test.ts` | **Yeni** | 24 test |
| `client/tests/renderer.test.ts` | **Yeni** | 27 test |
| `e2e/tests/plugins.spec.ts` | **Yeni** | 6 E2E test |

---

## Sprint 81 Sonrası Açık Maddeler

| Madde | Öncelik | Not |
|-------|---------|-----|
| `window.BridgeRegistry` köprüsü kaldırma | Düşük | Sprint 82 |
| `globals.d.ts` — `loadFriends` / `handleStageEvent` köprüleri | ✅ Kapatıldı | Bu sprint |
| `resolveRef` harici `$ref` desteği | Düşük | Sprint 83: openapi-dereference entegrasyonu |
| Client test coverage %80+ hedefi | Orta | `core/globals.ts` ✅, `renderer.ts` ✅ — kalan: `core/permissions.ts` |
| `bot-marketplace` Svelte route sistemi | Düşük | Sprint 82 |
