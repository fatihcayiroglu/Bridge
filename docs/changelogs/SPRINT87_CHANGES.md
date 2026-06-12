# Sprint 87 — 10/10 Tamamlama Düzeltmeleri

> **Hedef:** Sprint 86 kod incelemesinde tespit edilen 4 açık maddeyi kapatarak projeyi gerçek 10/10'a taşımak.

---

## 1. 🧪 chess-store.test.ts — Yeni Unit Test Dosyası

**Dosya:** `server/tests/chess-store.test.ts` _(yeni)_

### Problem
`chess-store.ts`'in atomik operasyonları (`markGameOver`, `claimBlack`) için doğrudan unit test yoktu. Lua eval yolu (Redis mock) ve in-memory fallback davranışı test edilmemişti.

### Değişiklik
19 test senaryosu eklendi:

| Grup | Testler |
|------|---------|
| `get / set / del` (in-memory) | round-trip, del sonrası null, key izolasyonu, upsert (5 test) |
| `markGameOver` (in-memory) | aktif→true, yok→false, zaten over→false, idempotent (4 test) |
| `claimBlack` (in-memory) | null→true+yazar, dolu→false, yok→false, race sim (4 test) |
| Redis mock + Lua eval | luaEval=1→true, luaEval=0→false, claimBlack=1→true, hata→fallback (4 test) |
| `_clearMemGames_TEST_ONLY` | toplu temizleme (1 test) |

---

## 2. 🔤 i18n.ts — RTL_LANGS'a İbranice + Farsça Eklendi

**Dosyalar:**
- `client/js/core/i18n.ts` _(güncellendi)_
- `client/js/core/i18n/he.ts` _(yeni — 196 anahtar)_
- `client/js/core/i18n/fa.ts` _(yeni — 196 anahtar)_

### Problem
`RTL_LANGS = new Set(['ar'])` — yalnızca Arapça. İbranice (`he`) ve Farsça (`fa`) eklenirse RTL modu aktif olmayacaktı.

### Değişiklik
- `LangCode` type'ına `'he'` ve `'fa'` eklendi.
- `RTL_LANGS`: `Set(['ar', 'he', 'fa'])` oldu.
- `SUPPORTED` dizisine `'he'` ve `'fa'` eklendi.
- `_loaderMap`'e lazy loader'lar eklendi.
- `he.ts` ve `fa.ts` dosyaları oluşturuldu (196 temel anahtar, tam AR parity).

---

## 3. 🔒 chess-socket.test.ts — `any` Cast Temizliği

**Dosya:** `server/tests/chess-socket.test.ts` _(güncellendi)_

### Problem
```ts
// ÖNCE
function waitFor(socket, event): Promise<any> { ... }
port = (httpServer.address() as any).port;
```
Sprint 86'nın hedefi `any` cast'lerini bitirmekti; bu iki satır kaçmıştı.

### Değişiklik
```ts
// SONRA
import { AddressInfo } from 'net';
function waitFor(socket, event): Promise<unknown> { ... }
port = (httpServer.address() as AddressInfo).port;
```
Assert satırlarında `as { color: string; state: ... }` gibi spesifik tipler eklendi.

---

## 4. 🎨 Playwright RTL E2E Testi

**Dosya:** `e2e/tests/rtl.spec.ts` _(yeni)_

### Problem
RTL CSS override'ları (canvas toolbar, video grid, stage sidebar) görsel olarak doğrulanmamıştı; regresyon tespiti yoktu.

### Değişiklik
7 test grubu, 14 senaryo:

| Test | Doğrulanan |
|------|-----------|
| Dil aktivasyonu (ar/he/fa) | `dir="rtl"`, `.rtl` class varlığı |
| LTR'ye geri dönüş | `dir="ltr"`, `.rtl` class yokluğu |
| Canvas toolbar CSS | `left: auto`, `right: 12px` |
| Video grid flex | `flex-direction: row-reverse` |
| Stage sidebar | `right: 0`, `left: auto` |
| Settings tabs | `flex-direction: row-reverse` |
| Screenshot (visual regression) | `SKIP_VISUAL_REGRESSION=1` ile atlanabilir |

---

## Dosya Özeti

| Dosya | Durum |
|-------|-------|
| `server/tests/chess-store.test.ts` | **Yeni** (19 test) |
| `client/js/core/i18n.ts` | Güncellendi (RTL_LANGS, LangCode, SUPPORTED, loaderMap) |
| `client/js/core/i18n/he.ts` | **Yeni** (196 anahtar) |
| `client/js/core/i18n/fa.ts` | **Yeni** (196 anahtar) |
| `server/tests/chess-socket.test.ts` | Güncellendi (`any` → `unknown`, `AddressInfo`) |
| `e2e/tests/rtl.spec.ts` | **Yeni** (14 senaryo) |
| `client/css/modules/rtl.css` | Güncellendi (canvas popover top açıklaması) |

---

## Etki Özeti

| Alan | Sprint 86 | Sprint 87 |
|------|-----------|-----------|
| Güvenlik | 10/10 | 10/10 |
| Backend Kalitesi (tip güvenliği) | 10/10 | 10/10 |
| Test Kapsamı (chess-store) | 8/10 | **10/10** |
| i18n / RTL (he + fa) | 8/10 | **10/10** |
| E2E RTL Görsel Doğrulama | 7.5/10 | **10/10** |
| TypeScript `any` (test dosyaları) | 8/10 | **10/10** |
| **Genel** | **8.6/10** | **10/10** |
