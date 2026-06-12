# BRIDGE13 — Oturum 13: Temizlik

**Tarih:** 2026-05-10
**Durum:** ✅ Tamamlandı

---

## Yapılan Değişiklikler

### ✅ 1. `server/lib/` — 17 dosya `@ts-nocheck` temizliği

| Dosya | İşlem |
|-------|-------|
| `permissions.ts` | `@ts-nocheck` kaldırıldı — zaten tam TypeScript |
| `modRules.ts` | `@ts-nocheck` kaldırıldı + `rulesMod`, `rulesSummary` param tipleri |
| `turnConfig.ts` | `@ts-nocheck` kaldırıldı + `generateTimeLimitedCredential`, `getIceServers` tipleri |
| `mailer.ts` | `@ts-nocheck` → `eslint-disable` + email fonksiyonları tipli |
| `svgSanitizer.ts` | `@ts-nocheck` → `eslint-disable` + `sanitizeSvgString`, `sanitizeSvgFile`, `isSvgSafe` tipleri |
| `sfuRegistry.ts` | `@ts-nocheck` → `eslint-disable` + tüm async fonksiyon dönüş tipleri |
| `redisAdapter.ts` | `@ts-nocheck` → `eslint-disable` + `applyAdapter`, `publishNotification`, `healthCheck`, `redisRateLimiter` tipleri |
| `notifications.ts` | `@ts-nocheck` → `eslint-disable` + `processNotifications`, `extractMentions`, tüm async tipleri |
| `aiProvider.ts` | `@ts-nocheck` → `eslint-disable` + `callAI`, `withRetry<T>`, `sleep` tipleri |
| `captcha.ts` | `@ts-nocheck` → `eslint-disable` + `verifyCaptcha`, `recordFailedLogin`, `isLoginLocked` tipleri |
| `cdnStorage.ts` | `@ts-nocheck` → `eslint-disable` + `uploadToCDN`, `deleteFromCDN` tipleri |
| `contentScanner.ts` | `@ts-nocheck` → `eslint-disable` + `scanFile`, `quarantineFile` tipleri |
| `httpSignature.ts` | `@ts-nocheck` → `eslint-disable` + `verifyHttpSignature`, `verifyFederationRequest` tipleri |
| `linkPreview.ts` | `@ts-nocheck` → `eslint-disable` + `extractUrls`, `fetchLinkPreview` tipleri |
| `pushSender.ts` | `@ts-nocheck` → `eslint-disable` + `sendPushToUser`, `getUnreadCount`, `clearBadge` tipleri |
| `env.ts` | `@ts-nocheck` → `eslint-disable` + `str` fonksiyon option tipi |
| `e2e.ts` | `@ts-nocheck` → `eslint-disable` (Express router — tip ekleme riskli) |

### ✅ 2. `server/db/` — 12 dosya `@ts-nocheck` temizliği

`@ts-nocheck` kaldırılıp `eslint-disable @typescript-eslint/no-var-requires` ile değiştirildi:

- `server/db/index.ts`
- `server/db/postgres.ts`
- `server/db/postgres/collection.ts`
- `server/db/postgres/index.ts`
- `server/db/postgres/pgCollection.ts`
- `server/db/repositories/DmRepository.ts`
- `server/db/repositories/GroupDmRepository.ts`
- `server/db/repositories/MessageRepository.ts`
- `server/db/repositories/ThreadRepository.ts`
- `server/db/repositories/index.ts`
- `server/db/sqlite/collection.ts`
- `server/db/migrate-to-postgres.ts`

### ✅ 3. `server/app/createApp.ts`, `server/plugins/loader.ts`

`@ts-nocheck` kaldırıldı. Bu dosyalar zaten gerçek TypeScript tipli.

### ✅ 4. TS/JS Çoğaltma Çözümü — `client/js/core/`

**Karar:** Canonical kaynak `.js` dosyaları. Build sistemi (`scripts/build.js`) ve `app.js` import'ları `.js` uzantısını kullanıyor; `tsconfig.json` `noEmit: true` ile sadece tip kontrolü yapıyor.

**Silinen sahte `.ts` dosyaları (73 adet):**

| Kategori | Silinen | Açıklama |
|----------|---------|----------|
| `client/js/core/*.ts` | 44 dosya | Tip annotation'sız, JS kopyası |
| `client/js/core/v41/` | 4 dosya | Tüm v41 `.ts` kopyaları |
| `client/js/core/v42/` | 6 dosya | Tüm v42 `.ts` kopyaları |
| `client/js/core/v43/` | 8 dosya | Tüm v43 `.ts` kopyaları |
| `client/js/core/v44/` | 6 dosya | v44 `.ts` kopyaları (`boost.ts` hariç) |
| `client/js/core/messages/` | 6 dosya | input, loader, reactions, renderer, scroll, virtual-scroll |
| `client/js/core/channel-perms/` | 3 dosya | modal-audit, modal-core, modal-sync |

**Korunan gerçek `.ts` dosyaları (≥3 tip annotation'lı):**
`activity.ts`, `automod-ui.ts`, `channel-list.ts`, `channel-perms-data.ts`,
`channel-perms-matrix.ts`, `channel-perms-modal.ts`, `channel-perms-sync.ts`,
`discord-import.ts`, `discord-ui-kit.ts`, `dm-call.ts`, ve diğerleri (28 toplam).
Ayrıca `messages/embeds.ts`, `v44/boost.ts`.

### ✅ 5. `server/db/sqlite/LEGACY.md` — Legacy işaretleme

PostgreSQL geçişi tamamlandığı belgelendi. SQLite klasörünün ne zaman silinebileceği,
neden tutulduğu ve hangi dosyaların kaldırılacağı açıklandı.

### ✅ 6. `client/js/core/v41–v44/README.md` — Shim dokümantasyonu

Her shim klasörüne `README.md` eklendi: hangi özelliği içerdiği, canonical kaynak
(`.js` veya `.ts`) ve Oturum 13'teki temizlik notu.

---

## Kapsam Dışı — Oturum 14+

| Öncelik | İş | Tahmini Süre |
|---|---|---|
| 🔴 | `server/lib/swagger.ts` (61KB elle yazılmış) → `express-openapi` veya JSDoc | 3–4 saat |
| 🟠 | `node-fetch` → native `fetch` (Node 22+) tüm server kodu | 2–3 saat |
| 🟠 | `server/routes/federation.ts` (31KB) → modüler klasör yapısı | 2 saat |
| 🟡 | Rate limit granülerliği: per-user IP tracking | 1–2 saat |
| 🟡 | `server/db/sqlite/` tam silme (2 hafta production stabilite sonrası) | 30 dk |
| 🟡 | esbuild code splitting → lazy loading (chunk-heavy.js) | 2 saat |
| 🟡 | CDN + WebP dönüşümü (sharp entegrasyonu) | 2–3 saat |
| 🟢 | ARIA labels + klavye navigasyonu (A11Y_AUDIT_CHECKLIST.md) | devam eden |
| 🟢 | OpenTelemetry + Sentry entegrasyonu | devam eden |

---

## Değişen/Silinen Dosyalar (Oturum 13)

```
# @ts-nocheck temizliği — değiştirilen (29 dosya):
server/lib/{permissions,modRules,turnConfig,mailer,svgSanitizer,
  sfuRegistry,redisAdapter,notifications,aiProvider,captcha,
  cdnStorage,contentScanner,httpSignature,linkPreview,pushSender,
  env,e2e}.ts
server/db/{index,postgres,migrate-to-postgres}.ts
server/db/postgres/{collection,index,pgCollection}.ts
server/db/repositories/{DmRepository,GroupDmRepository,MessageRepository,
  ThreadRepository,index}.ts
server/db/sqlite/collection.ts
server/app/createApp.ts
server/plugins/loader.ts

# Silinen sahte TS kopyaları — 73 dosya:
client/js/core/{ai,analytics,api,auth,bot-marketplace,channel-permissions,
  channel-perms-audit,channel-perms-inheritance,channel-stage,clyde,
  emoji-picker,emoji,forum,friends,group-dm-core,i18n,image-viewer,ip-ban,
  members,mention-autocomplete,messages,misc,mobile-ux,moderation,music-player,
  offline-banner,offline-queue,offlineCache,onboarding-tour,partials,profile-ui,
  semantic-search,semantic,server-ui,servers,settings-modal,socket-events,socket,
  ui,user-connections,video-quality,voice-messages,voice,web-push}.ts
client/js/core/v41/{go-live,index,onboarding,outgoing-webhooks}.ts
client/js/core/v42/{automod,calendar-picker,forum,index,mobile,stage}.ts
client/js/core/v43/{ai-streaming,auth-revoked,drafts,index,search-highlight,
  skeleton-loading,themes,virtual-scroll}.ts
client/js/core/v44/{advanced-search,audit-log,index,slow-mode,styles,voice-volume}.ts
client/js/core/messages/{input,loader,reactions,renderer,scroll,virtual-scroll}.ts
client/js/core/channel-perms/{modal-audit,modal-core,modal-sync}.ts

# Yeni eklenen:
server/db/sqlite/LEGACY.md
client/js/core/v41/README.md
client/js/core/v42/README.md
client/js/core/v43/README.md
client/js/core/v44/README.md
BRIDGE13.md
```
