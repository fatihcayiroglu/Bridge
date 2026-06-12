# Sprint 51 Değişiklikleri

## PHASE 1 — Client `any` Tam Temizliği (275 → 0)

### Temizlenen dosyalar

| Dosya | Önceki `any` | Teknik değişiklik |
|-------|-------------|-------------------|
| `core/servers.ts` | 33 | `Window` arayüzü kullanıldı, `(window as any)` cast'leri kaldırıldı |
| `core/messages/input.ts` | 32 | `getCurrentChannel/getSocket` dönüş tipleri iyileştirildi |
| `core/forum.ts` | 29 | `apiFetch` import edildi, `window.API` güvenli erişim |
| `core/music-player.ts` | 26 | Socket/channel cast'leri typed interface'e çevrildi |
| `core/emoji.ts` | 22 | `apiFetch` import, window globals kullanıldı |
| `core/profile-ui.ts` | 18 | `apiFetch` import, `window.me` typed cast |
| `core/onboarding.ts` | 18 | `apiFetch` import, `window.currentServer` typed |
| `core/socket-events.ts` | 14 | `friendsList` typed, socket interface eklendi |
| `core/ui.ts` | 12 | `apiFetch` import, window globals |
| `core/voice-messages.ts` | 10 | `apiFetch` import, typed error handling |
| `core/voice-activity-ui.ts` | 7 | Socket interface, AudioContext typed |
| `core/go-live.ts` | 6 | RTC typed interface, window globals |
| `core/slow-mode.ts` | 5 | `apiFetch` import, channel typed |
| `core/translate-btn.ts` | 4 | `err: unknown`, typed api call |
| `core/scheduled-ui.ts` | 4 | `catch (e: unknown)`, typed registry |
| `core/outgoing-webhooks.ts` | 4 | `apiFetch` import, window typed |
| `core/offline-queue.ts` | 4 | BridgeRegistry call typed |
| `core/image-viewer.ts` | 4 | `apiFetch` import, channel typed |
| `core/audit-log.ts` | 4 | `apiFetch` import, `getAPI` import |
| `js/polls.ts` | 2 | BridgeRegistry typed cast |
| `core/voice-volume.ts` | 2 | AudioContext typed |
| `core/offlineCache.ts` | 2 | `as unknown` registry pattern |
| `core/messages/renderer.ts` | 2 | Registry typed cast + `@ts-ignore` kaldırıldı |
| `js/profile.ts` | 1 | BridgeRegistry typed cast |
| `js/federation-modal.ts` | 1 | BridgeRegistry typed cast |
| `js/discover.ts` | 1 | `joinedServers` typed |
| `core/onboarding-tour.ts` | 1 | `as unknown` registry pattern |
| `core/members.ts` | 1 | `DmCall` typed cast |
| `core/globals.ts` | 1 | Yorum satırındaydı, kod any değildi |
| `core/drafts.ts` | 1 | `as unknown` registry pattern |
| `core/clyde.ts` | 1 | `as unknown` registry pattern |
| `core/canvas.ts` | 1 | `as unknown` registry pattern |
| `core/bridge-registry.ts` | 1 | `AnyFn`: `any[]` → `unknown[]` |
| `core/boost.ts` | 1 | getCurrentServer typed cast |

**Toplam:** 275 `any` → **0** (kod satırlarında)

### Teknik strateji

- `(window as any).X` → `window.X` (globals.d.ts zaten Window arayüzünü tanımlıyor)
- `(window as any).apiFetch(...)` → `apiFetch(...)` + `import { apiFetch } from './api-fetch.js'`
- `(window as any).API` → `window.API ?? getAPI()`
- `catch (e: any)` → `catch (e: unknown)` + `e instanceof Error ? e.message : String(e)`
- `BridgeRegistry.register(..., x as any)` → `x as unknown` (registry kabul ediyor)
- Socket/channel cast'leri → inline interface (`{ emit(...): void }`, `{ _id: string }`)
- `err.message` → `(err as Error).message` veya `instanceof Error` guard

---

## PHASE 2 — `encrypt-ap-keys.js` → TypeScript

`server/scripts/encrypt-ap-keys.js` → `server/scripts/encrypt-ap-keys.ts`

- `require()` → `import`
- `function encryptKey(plaintext)` → `function encryptKey(plaintext: string): string`
- `rows: ApKeyRow[]` interface eklendi
- `catch (err)` → `catch (err: unknown)`
- `main()` → `async function main(): Promise<void>`
- `tsconfig.json`'da `scripts/**/*.ts` zaten include — ek değişiklik gerekmedi

---

## PHASE 3 — Strict Gate Güncelleme

`tsconfig.strict-gate.json`: **41 → 72 dosya**

Sprint 51'de temizlenen 31 modül strict gate'e eklendi.

**Yeni eklenenler:**
`servers.ts`, `audit-log.ts`, `onboarding.ts`, `forum.ts`,
`messages/input.ts`, `messages/renderer.ts`, `go-live.ts`, `music-player.ts`,
`emoji.ts`, `profile-ui.ts`, `voice-messages.ts`, `voice-activity-ui.ts`,
`image-viewer.ts`, `ui.ts`, `slow-mode.ts`, `offline-queue.ts`,
`offlineCache.ts`, `voice-volume.ts`, `socket-events.ts`, `outgoing-webhooks.ts`,
`drafts.ts`, `canvas.ts`, `clyde.ts`, `onboarding-tour.ts`, `members.ts`,
`boost.ts`, `scheduled-ui.ts`, `polls.ts`, `profile.ts`, `federation-modal.ts`, `discover.ts`

**Sıradaki adaylar:** `channel-list.ts`, `discord-import.ts`, `semantic-search.ts`, `group-dm-voice.ts`

---

## Özet

| Kategori | Değişiklik |
|----------|-----------|
| Client `any` | 275 → **0** |
| `@ts-ignore` | 1 → **0** |
| Server JS scripti | `encrypt-ap-keys.js` → `.ts` |
| Strict gate | 41 → **72 dosya** |
| Server kaynak `.js` | **0** (değişmedi) |
| Client kaynak `.js` | **0** (değişmedi) |
---

## PHASE 4 — `globals.d.ts` Tamamlama

Sprint 51'de `(window as any).X` → `window.X` dönüşümü yapılırken kullanılan 20 fonksiyon `globals.d.ts`'deki `Window` arayüzünde tanımlı değildi. Eksik tanımlar eklendi:

`loadCaptchaConfig`, `checkAndShowOnboarding`, `openStatusPicker`, `openAddServerModal`,
`loadBridgeInfo`, `sendServerGif`, `loadChannelFiles`, `openForumThread`, `timeAgo`,
`loadScheduledBadge`, `initStatusPicker`, `handleUserActivity`, `loadFriends`,
`handleStageEvent`, `__changeScreenQuality`, `__musicAddToQueue`, `__musicSkip`,
`__musicStop`, `__obNext`, `__obPrev`, `__obComplete`, `_destroyTempModal`,
`executeSlashCommand`, `handleSlashKey`, `handleMentionKey`, `handleSlashInput`,
`handleMentionAutocomplete`, `showConfirmModal`, `cancelReply`, `clientConfig`

---

## PHASE 5 — `tsconfig.bridge5.json` Temizliği

`js/core/channel-perms/modal-core.ts` ve `js/slash.ts` Sprint 43'te strict'e geçirilmişti ama `tsconfig.bridge5.json` exclude listesinden çıkarılmamıştı. Her iki dosyada da `any` olmadığı doğrulandı, exclude'dan kaldırıldı.

**`bridge5.json` exclude:** 4 → 2 giriş (`node_modules`, `dist-session5`)
---

## PHASE 6 — Strict Gate %100 Kapsam

Strict gate **72 → 139 dosya** (tüm kaynak `.ts` dosyaları dahil edildi).

Sprint 51 öncesi gate dışında kalan 67 dosya incelendi:
- 66 tanesinde zaten `any` **yoktu** — doğrudan gate'e eklendi
- 1 tanesi (`soundboard.ts`) 2 adet `as any` içeriyordu → temizlendi, gate'e eklendi

**Sonuç: 132 kaynak `.ts` dosyasının tamamı `strict: true` altında kontrol ediliyor.**

---

## PHASE 7 — CI Genişletmeleri

### Test Coverage Raporu
`tests` job'una `test:coverage` adımı eklendi. Her CI çalışmasında:
- `text-summary` → konsola özet
- `lcov` → artifact olarak 14 gün saklanıyor (`coverage-report-{sha}`)

### Bundle Per-Chunk Analizi
`build` job'una `--verbose --ci` flagleriyle bundle analiz adımı eklendi. Hangi chunk'ın ne kadar yer kapladığı her PR'da görünür hale geldi.

---

## PHASE 8 — Migration Dokümantasyonu

`server/db/migrations/README.md` ve `server/db/migrations_pg/README.md` eklendi.

Tek paragrafla: `migrations/` = legacy SQLite (geriye uyumluluk), `migrations_pg/` = aktif PostgreSQL sistemi. İki klasör karmaşıklığı dokümante edildi, migration numaraları ve rollback prosedürü açıklandı.
---

## PHASE 9 — `client/tsconfig.json` Base Strict Aktivasyonu

`client/tsconfig.json` base config'de `strict: true`, `noImplicitAny: true`, `strictNullChecks: true` aktif edildi.

**Neden güvenli:**
- `globals.d.ts`'deki `Document.getElementById` ve `querySelector` override'ları non-null dönüş tipi sağlıyor — 763 çağrı yerde tek satır değişmeden çalışıyor
- Strict gate %100 kapsamda olduğu için CI zaten tüm dosyaları strict altında check ediyordu; base config değişikliği sadece IDE (VS Code, WebStorm) deneyimini senkronize etti
- `allowJs: true` / `checkJs: true` kaldırıldı — artık `.js` kaynak dosyası yok
- `include` güncellendi: `js/**/*.js` glob kaldırıldı

**`tsconfig.strict.json`:** `bridge5` yerine artık base `tsconfig.json`'u extend ediyor (base zaten strict, tekrar tanımlamaya gerek yok).

**Sonuç:**  
Geliştirici IDE'si ve CI artık aynı strictness seviyesinde — tip hataları hem local'de hem CI'da aynı anda görünür.
