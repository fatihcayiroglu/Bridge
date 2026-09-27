# Client TypeScript Migration Tracker

Sprint 51 güncel durumu.

## Genel Bakış

| Tip  | Sayı | Notlar |
|------|------|--------|
| `.ts` | 140 | Tam TypeScript — production `client/js` kaynakları |
| `.js` | 0   | **Kaynak JS dosyası kalmadı** ✅ |

**Hedef:** Tüm `core/` modülleri → `.ts`, `strict: true` altında temiz.  
**Durum:** JS→TS dönüşümü **tamamlandı**. `client/tsconfig.json` doğrudan `strict: true`; geçiş dönemi `tsconfig.strict-gate.json` kaldırıldı.

---

## Strict TypeScript Gate

Kademeli geçiş tamamlandı. CI ve yerel kalite zinciri artık doğrudan:

- `client/tsconfig.json` → `strict: true`
- `client/tsconfig.strict.json` → production `js/**/*.ts` için `noEmit` gate
- root `typecheck:strict-client` scripti → `tsc -p client/tsconfig.strict.json --noEmit`

Eski dosya-listeli `tsconfig.strict-gate.json` bilinçli olarak kaldırıldı; source tree değiştikçe stale dosya listesi üretme riski taşımıyordu. Sprint 40–51 ayrıntıları tarihsel changeloglarda korunur.

---

## Bundle Budget

Mevcut limit: **1.2 MB** JS (Sprint 50'de 1.1 MB → 1.2 MB güncellendi).  
CSS limiti: **250 KB**. Tek chunk max: **150 KB**.

Budget scripti `build:ci` zincirinde **aktif** — CI'daki `Build` job'u bunu çalıştırır.

---

## Teknik Notlar

- `strict: true` artık base client config’in kalıcı sözleşmesidir; ayrı dosya-listeli geçiş gate’i yoktur.
- `allowJs: true` + `checkJs: true` artık geçersiz — tüm kaynak `.ts`.
- `(window as any).X` → `window.X` stratejisi: `globals.d.ts` `Window` arayüzünü kapsamlı tanımladığı için cast gereksizdi.
- `catch (e: any)` → `catch (e: unknown)` + `instanceof Error` guard — Sprint 51'de standart hale getirildi.
- Registry cast pattern: `as any` → `as unknown` (BridgeRegistry tip agnostik tasarım gereği).

---

## Sprint D — API Versioning (Tamamlandı)

1. **`setupRoutes.ts`** — `/api` rotalarına `Deprecation: true` + `Link` header eklendi.
2. **`lib/swagger.ts`** — `/api` server açıklaması deprecated olarak işaretlendi.
3. **`bot-sdk/src/index.ts`** — `Deprecation` header tespiti + `console.warn` + event emit.

### Başarı Kriterleri ✅
- [x] `/api/...` istekleri `Deprecation: true` header taşıyor
- [x] Swagger UI'da `/api/v1` canonical olarak gösteriliyor
- [x] Bot SDK `Deprecation` header görünce `console.warn` basıyor
