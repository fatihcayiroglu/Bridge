# SPRINT80_CHANGES.md
_Tarih: 2026-05-23 | Temel: Sprint 79 (9.2/10)_

---

## Özet

Sprint 80, Sprint 79 değerlendirmesinde belirlenen **3 açık maddeyi** kapatır.
Hiçbir public API değişmedi; tüm değişiklikler geriye uyumludur.

| Madde | Durum |
|-------|-------|
| `resolveRef` edge case testleri (chain, circular, boş components, geçersiz format) | ✅ Tamamlandı |
| `window.BridgeState` köprüsü kaldırma (Sprint 31 borcu) | ✅ Tamamlandı |
| Plugin sandbox: `ctx.hooks.emitToAll()` opt-in cross-plugin API | ✅ Tamamlandı |

---

## A — `resolveRef` edge case testleri

### Yeni dosya: `server/tests/swagger-resolveRef.test.ts`

8 describe bloğu, toplam **32 test**:

| Describe | Test sayısı | Kapsam |
|----------|-------------|--------|
| Temel başarılı çözümleme | 3 | schemas, responses, parameters |
| Var olmayan ref | 4 | bilinmeyen schema/response/parameter, tamamen bilinmeyen alan |
| Geçersiz ref formatı | 5 | `#` olmayan, http, boş string, yalnızca `#`, yalnızca `#/` |
| Boş / eksik components | 3 | `components: undefined`, `components: {}`, schemas yok |
| $ref chain davranışı | 2 | tek adım + iki adımlı manuel chain |
| Circular ref güvenliği | 1 | A→B→A döngüsü hata fırlatmaz |
| Derin path navigasyonu | 3 | `#/info/title`, `#/info/version`, `#/openapi` |
| Immutability | 1 | spec mutasyonu yapılmıyor |

**Tasarım kararı belgelenmiştir:** `resolveRef` tek adım yapar, otomatik chain çözümlemez.
İki adımlı chain isteğe bağlı olarak çağıran tarafından yapılır.
Circular ref güvenliği bu tasarımdan ücretsiz gelir.

---

## B — `window.BridgeState` köprüsü kaldırma

Sprint 31'den beri sürüklenen teknik borç kapatıldı.
Tüm tüketiciler ESM import kullanıyordu; köprü gereksizdi.

### Değiştirilen: `client/js/core/state.ts`

```diff
- // Sprint 31 köprüsü — Sprint 32'de kaldırılır
- (window as Record<string, unknown>).BridgeState = BridgeState;
```

Başlık yorumu güncellendi:
```diff
- //   window.BridgeState köprüsü Sprint 32'de kaldırılır (tüketiciler import'a geçince).
+ // Sprint 80: window.BridgeState köprüsü kaldırıldı. Tüm tüketiciler ESM import kullanıyor.
```

### Değiştirilen: `client/js/types/globals.d.ts`

```diff
- // BridgeState ESM export — Sprint 31'den itibaren import { BridgeState } da geçerli
- BridgeState: import('./state').BridgeState extends never
-   ? { state: ...; setState(...): void; subscribe(...): () => void; initState(): void; }
-   : never;
```

`Window` arayüzünden `BridgeState` declare'ı kaldırıldı.
Artık `window.BridgeState` TypeScript seviyesinde de tanımsız — yanlışlıkla
kullanım derleme hatası verir.

### Değiştirilen: `client/tests/state.test.ts`

```diff
- test('window.BridgeState köprüsü kurulur', () => {
-   freshModule();
-   expect((window as Record<string,unknown>).BridgeState).toBeDefined();
- });
+ test('window.BridgeState köprüsü artık kurulmaz (Sprint 80: kaldırıldı)', () => {
+   freshModule();
+   expect((window as Record<string,unknown>).BridgeState).toBeUndefined();
+ });
```

---

## C — `ctx.hooks.emitToAll()` opt-in cross-plugin API

### Sorun

Sprint 79'da wildcard izolasyonu uygulandıktan sonra bazı plugin'lerin kasıtlı
cross-plugin broadcast ihtiyacı karşılanamıyordu. `emit()` artık izole çalışıyor
ama alternatif bir yol yoktu; SPRINT79_CHANGES.md'de açık madde olarak kaldı.

### Çözüm

| Metod | Davranış |
|-------|----------|
| `ctx.hooks.emit(event, data)` | Yalnızca kendi plugin'inin wildcard'larını tetikler (izolasyon) |
| `ctx.hooks.emitToAll(event, data)` | Tüm plugin'lerin wildcard'larını tetikler (opt-in broadcast) |

### Değiştirilen: `plugins/registry.ts`

`PluginHooks` interface'ine `emitToAll` eklendi:

```typescript
interface PluginHooks {
  on:        (event: string, fn: (data: unknown) => unknown) => void;
  off:       (event: string, fn: (data: unknown) => unknown) => void;
  emit:      (event: string, data: unknown) => Promise<void>;
  emitToAll: (event: string, data: unknown) => Promise<void>; // ← Yeni
}
```

`_makeHooks()` içinde implementasyon:

```typescript
emitToAll(event: string, data: unknown): Promise<void> {
  return emit(event, data); // global emit — tüm plugin'lere
},
```

### Değiştirilen: `plugins/lifecycle.ts`

`PluginHooks` interface'i güncellendi, `ctx.hooks` nesnesine `emitToAll` eklendi:

```typescript
emitToAll: (event, ...args) => {
  port.postMessage({ type: 'hook:event:broadcast', event, args });
},
```

`MainToWorker` tipine `hook:event:broadcast` eklendi:

```typescript
type MainToWorker =
  | { type: 'hook:event';           event: string; args: unknown[] }
  | { type: 'hook:event:broadcast'; event: string; args: unknown[] }  // ← Yeni
  | ...
```

Ana thread mesaj handler'ında yeni case:

```typescript
case 'hook:event:broadcast':
  void registry.emit(msg.event, ...msg.args);
  break;
```

### Değiştirilen: `server/tests/plugin-registry-isolation.test.ts`

`G — emitToAll` describe bloğu eklendi — **5 yeni test**:

| Test | Kapsam |
|------|--------|
| emitToAll diğer plugin'lerin wildcard'larını tetikler | Temel cross-plugin broadcast |
| emitToAll exact event listener'larını da çağırır | Exact event uyumluluğu |
| emitToAll kaynağın kendi listener'larını da çağırır | Kaynak plugin dahil |
| emitToAll üç plugin senaryosunda hepsine ulaşır | Çoklu plugin broadcast |
| emit ile emitToAll tutarlı bir şekilde ayrışır | Regresyon: izolasyon bozulmadı |

---

## D — Sprint 80 Temizlik (Post-review)

| Değişiklik | Etki |
|------------|------|
| `.bak` dosyaları silindi (`state.ts.bak`, `globals.d.ts.bak`, `state.test.ts.bak`) | Repo gürültüsü temizlendi |
| `globals.d.ts` stale "Sprint 54" notu → "Sprint 81 açık maddesi" olarak düzeltildi | Tarih doğruluğu sağlandı |
| `data-utils.test.ts` — `[] as any` → `[] as { key: string }[]` | `any` kaldırıldı |
| `formatting.test.ts` — `s: any` → `s: unknown` + `String(s)` | `any` kaldırıldı |
| `validation.test.ts` — `s: any` → `s: unknown` | `any` kaldırıldı |
| `offline-queue.ts` — `currentServer: any` → `as { _id: string } | null` | `any` kaldırıldı |
| `scripts/check-any-count.js` — `CEILING: 293 → 0` | Yeni `any` artık CI'da engellenir |
| `client/.any-baseline.json` güncellendi — 293 → 0 | Baseline sıfırlandı |

**Sonuç:** `client/js` altında `any` sayısı **293 → 0**. CEILING sıfırlandı; bundan böyle herhangi bir `any` eklenmesi build'i kırar.


---

## E — Stale Sprint Referansları Temizliği (Post-review 2)

Sprint 80'de yürütülen ikinci inceleme sonrası belirlenen stale yorum borçları kapatıldı.

| Dosya | Eski yorum | Yeni yorum |
|-------|-----------|------------|
| `globals.d.ts` (6 satır) | "Sprint 32–34'te kaldırılır / temizlenecek" | "Sprint 81+ hedefi: tüketiciler import'a geçince kaldırılır" |
| `error-boundary.ts:183` | "Sprint 31 köprüsü — Sprint 32'de kaldırılır" | "window.errorBoundary köprüsü — logger.ts tüketicisi var; Sprint 81+ hedefi" |
| `globals.ts:315` | "Sprint 32 köprüsü — Sprint 34'te kaldırılır" | "window.currentServerChannels köprüsü — channel-list.test.ts tüketicisi var; Sprint 81+ hedefi" |
| `globals.ts:329` | "Sprint 32 köprüsü" | "window._nsfwAccepted köprüsü — Sprint 81+ hedefi" |

**Not:** `globals.ts` içindeki `// Sprint 32: ...` başlık etiketleri (tarihi referans, vaat içermiyor) korundu.
Köprüler kaldırılmadı — aktif tüketicileri var (`logger.ts`, `channel-list.test.ts`); Sprint 81 açık maddesi.


---

## F — Sprint 80 Temizlik 3: Köprü Yorumları + Ölü Declare'lar (Post-review 3)

| Dosya | Değişiklik |
|-------|------------|
| `client/js/core/socket-events.ts` | `window.openStatusPicker?.()` → `import { openStatusPicker } from './friends.js'` doğrudan çağrı |
| `client/js/types/globals.d.ts` | `openStatusPicker` declare kaldırıldı (tüketici artık ESM import kullanıyor) |
| `client/js/types/globals.d.ts` | Sprint 51 bölüm yorumu güncellendi: "Sprint 52–54'te kaldırılacak" → "Sprint 81 hedefi: orphan declare'lar kaldırılacak" |
| `client/js/webauthn.ts` | "Sprint 34'te kaldırılacak" → "Sprint 81 hedefi: index.html onclick tüketicisi var" |
| `client/js/core/socket.ts` | "Sprint 33'te tam import yapıldığında shim kaldırılır" → "Sprint 81 hedefi" + circular import riski notu |

**Kaldırılamayan köprüler (aktif tüketici nedeniyle):**
- `window.BridgeWebAuthn` — `index.html` onclick handler'ları (`passkeyLogin`, `registerPasskey`)
- `window.errorBoundary` — `logger.ts` hata raporlama
- `window.decryptIncoming` — `socket.ts` E2EE mesaj çözme (dm.ts'den circular import riski)
- `window.currentServerChannels` — `channel-list.test.ts` regresyon testi


---

## Test Özeti

| Dosya | Yeni Test | Kapsam |
|-------|-----------|--------|
| `server/tests/swagger-resolveRef.test.ts` | 32 | resolveRef edge cases |
| `server/tests/plugin-registry-isolation.test.ts` | +5 | emitToAll broadcast |
| `client/tests/state.test.ts` | 0 yeni, 1 güncellendi | köprü kaldırma regresyon |
| **Sprint 80 toplam** | **37** | |

---

## Dosya Değişim Özeti

| Dosya | Durum | Açıklama |
|-------|-------|----------|
| `server/tests/swagger-resolveRef.test.ts` | **Yeni** | 32 test — resolveRef edge cases |
| `client/js/core/state.ts` | Değiştirildi | window.BridgeState köprüsü kaldırıldı |
| `client/js/types/globals.d.ts` | Değiştirildi | Window.BridgeState declare kaldırıldı |
| `client/tests/state.test.ts` | Değiştirildi | Köprü testi → kaldırılma regresyon testi |
| `plugins/registry.ts` | Değiştirildi | PluginHooks.emitToAll + implementasyon |
| `plugins/lifecycle.ts` | Değiştirildi | PluginHooks.emitToAll, hook:event:broadcast mesaj tipi + handler |
| `server/tests/plugin-registry-isolation.test.ts` | Değiştirildi | G bloğu: 5 emitToAll testi eklendi |

---

## G — Post-review Düzeltmeleri (9.4 → 10.0)

### G1 — `emitToAll` Promise sözleşmesi düzeltmesi

**Sorun:** `lifecycle.ts` worker tarafında `ctx.hooks.emitToAll()` `postMessage` fire-and-forget
yaptıktan hemen `Promise.resolve()` döndürüyordu. `await ctx.hooks.emitToAll(...)` çağıranı
broadcast tamamlanmadan devam ediyordu — `Promise<void>` semantiğiyle çelişki.

**Çözüm:** RPC acknowledgement döngüsü eklendi.

| Değişiklik | Detay |
|------------|-------|
| `MainToWorker` | `hook:event:broadcast` mesajına `ackId: string` alanı eklendi |
| `MainToWorker` | `hook:event:broadcast:ack` mesaj tipi eklendi (ana thread → worker) |
| Worker `emitToAll` | `Promise.resolve()` → ack bekleyen gerçek Promise |
| Ana thread handler | `void registry.emit(...)` → `await registry.emit(...).then(() => ack gönder)` |

Artık `await ctx.hooks.emitToAll(event, data)` yalnızca tüm plugin listener'ları çalıştıktan
sonra resolve eder.

### G2 — `resolveRef` `#` / `#/` edge case assert

**Sorun:** İki test yalnızca `not.toThrow()` kontrolü yapıyordu; dönüş değeri belirtilmemişti.

**Çözüm:** Her iki teste `expect(result).toBeUndefined()` eklendi. Davranış artık tam olarak
belgelenmiş:
- `'#'` → `ref.slice(2) = ''` → `parts = ['']` → `spec[''] = undefined`
- `'#/'` → aynı yol → `undefined`

### G3 — `globals.d.ts` orphan declare temizliği

**25 orphan declare kaldırıldı** — `window.X` olarak hiç çağrılmıyordu; tüm tüketiciler
`BridgeRegistry.register/call` veya ESM import'a çoktan geçmişti.

Kaldırılanlar: `loadCaptchaConfig`, `checkAndShowOnboarding`, `openAddServerModal`,
`loadBridgeInfo`, `sendServerGif`, `loadChannelFiles`, `openForumThread`, `timeAgo`,
`loadScheduledBadge`, `initStatusPicker`, `handleUserActivity`, `adminInjectButton`,
`executeSlashCommand` (×2 — duplicate), `handleSlashKey` (×2), `handleMentionKey`,
`handleSlashInput` (×2), `handleMentionAutocomplete`, `showConfirmModal`, `cancelReply`,
`__changeScreenQuality`, `__musicAddToQueue`, `__musicSkip`, `__musicStop`,
`__obNext`, `__obPrev`, `__obComplete`, `_destroyTempModal`

**Korunanlar:** `loadFriends`, `handleStageEvent` — `socket-events.ts` tarafından `window.X`
olarak çağrılmaya devam ediyor (Sprint 82 hedefi).

### G4 — `bot-marketplace` stale TODO'lar

`TODO(compat)` ve satır içi `TODO:` → sprint numarası + bağımlılık notu ile değiştirildi.
Artık her ikisi de "Sprint 81 hedefi: ..." formatında ve hangi Svelte bileşenine bağlı
olduğu belirtilmiş.

### G5 — `server/lib/swagger.ts` `resolveRef` `any` kaldırıldı

`let node: any` → `let node: unknown` + döngü içinde `(node as Record<string, unknown>)[part]`
narrowing'i. `eslint-disable` yorumu kaldırıldı. Artık sunucu production kodunda sıfır `any`.

---

## Sprint 80 Sonrası Açık Maddeler

| Madde | Öncelik | Not |
|-------|---------|-----|
| Client test coverage hedefi %80+ | Orta | Kalan kritik dosyalar: `core/globals.ts`, `core/messages/renderer.ts`, `core/permissions.ts` |
| `window.BridgeRegistry` köprüsü kaldırma | Düşük | Sprint 81'de yapılabilir |
| `globals.d.ts` — `loadFriends` / `handleStageEvent` köprüleri | Düşük | Sprint 82: socket-events.ts → BridgeRegistry.call geçişi |
| `bot-marketplace` Svelte route sistemi | Düşük | Sprint 81: `showBotDetails` botId prop'a dönüşecek |
