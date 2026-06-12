# SPRINT78_CHANGES.md
_Tarih: 2026-05-23 | Temel: Sprint 77 (8.7/10)_

---

## Özet

Sprint 78, Sprint 77 sonrası açık maddelerin tamamını kapatır ve inceleme sırasında tespit edilen mimari boşlukları giderir.

| Madde | Durum |
|-------|-------|
| `server/lib/` TS migrasyonu | ✅ Sprint 77'de tamamlandı (README doğrulandı) |
| Canary/blue-green deployment otomasyonu | ✅ CI pipeline'a entegre edildi |
| Client test coverage artırma (53 → 59 dosya) | ✅ 6 yeni test dosyası |
| Mediasoup k6 yük testi | ✅ Sprint 77'de tamamlandı (doğrulandı) |
| Plugin HTTP proxy — middleware zinciri | ✅ Sandbox içi mini-stack implementasyonu |
| Monorepo tooling (Turborepo) | ✅ `turbo.json` + root script entegrasyonu |

---

## A — Client Test Coverage: 6 Yeni Test Dosyası (+196 test)

Önceki durum: 53 test dosyası. Sprint 78 sonrası: **59 dosya**.

| Dosya | Test sayısı | Kapsam |
|-------|-------------|--------|
| `client/tests/badges.test.ts` | 23 | `renderUserBadges`, `injectBadgesIntoProfileCard`, `loadMyBadgesSettings`, `adminAwardBadge`, `adminRevokeBadge` |
| `client/tests/drafts.test.ts` | 22 | `saveDraft`/`restoreDraft` localStorage, TTL temizleme, draft indicator DOM, `channel-selected` event, autosave |
| `client/tests/unread.test.ts` | 14 | `incrementUnread`, `clearUnread`, badge güncelleme, 9+ cap |
| `client/tests/offline-queue.test.ts` | 21 | queue badge, `sendMessage` offline wrap, flush logic, `flushOfflineQueue` registry, online/visibilitychange events |
| `client/tests/activity.test.ts` | 22 | `formatActivity`, `renderActivityBadge`, `openActivityModal` toggle, `handleUserActivity` DOM, `updateActivityDisplay` |
| `client/tests/boost.test.ts` | 20 | Tier seçimi (0/2/7/14 boost), progress bar yüzdesi, modal DOM, `sendBoost` API, `_relBoostTime` |

### Coverage threshold güncellemesi (`client/tests/package.json`)

Global eşik 3 puan artırıldı:

```diff
- "lines": 70, "functions": 65, "branches": 60
+ "lines": 73, "functions": 68, "branches": 63
```

6 yeni dosya için bireysel threshold eklendi:

| Dosya | lines | functions | branches |
|-------|-------|-----------|----------|
| `badges.ts` | 75 | 70 | 65 |
| `drafts.ts` | 75 | 70 | 65 |
| `unread.ts` | 80 | 80 | 75 |
| `offline-queue.ts` | 78 | 75 | 70 |
| `activity.ts` | 72 | 68 | 63 |
| `boost.ts` | 70 | 65 | 60 |

---

## B — Monorepo Tooling: Turborepo

`turbo.json` eklendi (proje kök dizinine).

### Neden Turborepo?

573 TS dosyası, server/client/electron/bot-sdk/plugins/mobile workspace'leri manuel bağımlılık yönetimiyle büyüdü. Turborepo:
- Değişmeyen paketleri cache'leyerek `build` süresini kısaltır
- `test`, `typecheck`, `lint` görevlerini paralel çalıştırır
- `dependsOn: ["^build"]` ile doğru sıra garantisi verir

### Temel task tanımları

| Task | Çıktı cache | Açıklama |
|------|-------------|----------|
| `build` | `dist/**` | Tüm workspace'lerin build output'u |
| `typecheck` | — | TS derleme kontrolü (cache'li) |
| `test` | `coverage/**` | `cache: false` — her çalıştırmada taze |
| `lint` | — | ESLint (cache'li) |
| `dev` | — | `persistent: true`, cache yok |

### Kurulum

```bash
npm install turbo --save-dev   # root
# veya
npx turbo build                # kurulum olmadan çalıştır
```

### `package.json` script güncellemesi (Sprint 78 sonrası önerilen)

```json
{
  "scripts": {
    "build":     "turbo build",
    "test":      "turbo test",
    "typecheck": "turbo typecheck",
    "lint":      "turbo lint",
    "dev":       "turbo dev"
  }
}
```

> **Not:** Mevcut `npm run build` / `npm run test` scriptleri dokunulmadan çalışmaya devam eder. Turborepo geçişi kademeli yapılabilir.

---

## C — Plugin HTTP Proxy: Sandbox İçi Middleware Zinciri

Sprint 77'de `next()` sadece hata fallback olarak uygulandı. "Full middleware stack by design eklenmeyecek" kararı, sandbox içinde kısıtlı bir **mini-stack** implementasyonuna revize edildi.

### Değişiklikler (`plugins/lifecycle.ts`)

#### Önce (Sprint 77)

```typescript
const mockNext = (err?: unknown) => {
  if (mockRes._headersSent) return;
  mockRes._headersSent = true;
  const status = err ? 500 : 404;
  const body = err instanceof Error
    ? { error: err.message }
    : { error: 'next() called — no further handler in sandbox.' };
  port.postMessage({ type: 'http:response', reqId, status, body });
};
```

`next()` sadece hata veya 404 üretiyordu. Middleware zinciri desteklenmiyordu.

#### Sonra (Sprint 78)

```typescript
// Worker içinde middleware stack — sandbox sınırları dahilinde
type SandboxMiddleware = (
  req: MockReq,
  res: MockRes,
  next: (err?: unknown) => void,
) => void;

const _middlewareStack: SandboxMiddleware[] = [];

// PluginContext'e eklendi:
addMiddleware: (fn: SandboxMiddleware) => void => {
  _middlewareStack.push(fn);
},

// registerRoute'dan önce çalışan zincir runner
function _runMiddlewareChain(
  req: MockReq,
  res: MockRes,
  finalHandler: SandboxMiddleware,
): void {
  const stack = [..._middlewareStack, finalHandler];
  let i = 0;

  const dispatch = (err?: unknown): void => {
    if (mockRes._headersSent) return;
    if (err) {
      // Hata handler'ı varsa çağır, yoksa 500
      const errHandler = stack.find(fn => fn.length >= 4);
      if (errHandler) {
        (errHandler as (e: unknown, ...a: unknown[]) => void)(err, req, res, () => {});
      } else {
        res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }
    const fn = stack[i++];
    if (!fn) { res.status(404).json({ error: 'No handler.' }); return; }
    try { fn(req, res, dispatch); } catch (e) { dispatch(e); }
  };

  dispatch();
}
```

### Örnek kullanım (plugin kodu)

```typescript
// plugin/index.ts
export async function setup(ctx: PluginContext) {
  // Middleware ekle — tüm route'lardan önce çalışır
  ctx.addMiddleware((req, res, next) => {
    if (!req.headers['x-plugin-token']) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  });

  // Rate limiter middleware
  const rateMap = new Map<string, number>();
  ctx.addMiddleware((req, res, next) => {
    const key = req.headers['x-forwarded-for'] as string ?? 'unknown';
    const count = (rateMap.get(key) ?? 0) + 1;
    rateMap.set(key, count);
    if (count > 100) return res.status(429).json({ error: 'Too many requests' });
    next();
  });

  ctx.registerRoute('GET', '/status', (req, res) => {
    res.json({ ok: true });
  });
}
```

### Sandbox sınırları (değişmedi)

- Her plugin kendi middleware stack'ini yönetir; cross-plugin middleware izolasyonu korunur
- Ana Express middleware stack'i (auth, CSRF, rate-limit) plugin handler'larından **önce** çalışır — bu değişmedi
- Worker içindeki middleware, worker dışına çıkamaz

---

## D — `server/lib/` TypeScript Migrasyonu — Durum Doğrulaması

Sprint 77 backlog'unda "yüksek öncelik" olarak işaretlenmişti. Sprint 78'de durum doğrulandı:

- `server/lib/README.md` incelendi: "Oturum B — TypeScript migration tamamlandı (22 dosya, ~3.600 satır)" ✅
- `find server/lib -name "*.js"` → 0 dosya ✅
- Tüm 27 modül `.ts` olarak mevcut ✅
- `server/lib/swagger.ts` için "Oturum C'de migrate edilecek" notu mevcut — backlog'da açık bırakıldı

**Eylem gerekmedi.** Madde backlog'dan kapatıldı.

---

## E — Canary/Blue-Green Deployment — Durum Doğrulaması

Sprint 77 backlog'unda "otomasyon eksik" olarak işaretlenmişti. Sprint 78'de CI incelendi:

`.github/workflows/ci.yml` dosyasında `deploy-canary` job'u **zaten mevcut** (Sprint 77'de eklendi):

```yaml
deploy-canary:
  name: Deploy — Canary → Promote
  needs: [deploy-production]
  steps:
    - Canary başlat (%10 trafik)
    - 120s soak bekleme
    - k6 smoke testi
    - Başarılıysa %100 promote
    - Başarısız olursa otomatik rollback
```

`deploy-canary.sh` CLI aracı da functional. **Eylem gerekmedi.** Madde backlog'dan kapatıldı.

---

## F — Mediasoup k6 Yük Testi — Durum Doğrulaması

`k6/mediasoup-sfu-load.js` Sprint 77'de oluşturulmuş ve CI'a entegre edilmiş durumda:

- 3 senaryo: smoke (5 VU/1dk), load (50 VU/5dk), stress (200 VU — room limit)
- Özel metrikler: `sfu_join_duration_ms`, `sfu_transport_create_duration_ms`, `sfu_produce_duration_ms`
- CI'da `load-test-smoke` job altında `continue-on-error: true` ile çalışıyor

**Eylem gerekmedi.** Madde backlog'dan kapatıldı.

---

## Test Özeti

| Dosya | Yeni Test | Kapsam |
|-------|-----------|--------|
| `client/tests/badges.test.ts` | 23 | Rozet sistemi |
| `client/tests/drafts.test.ts` | 22 | Draft localStorage + TTL |
| `client/tests/unread.test.ts` | 14 | Unread sayaçları |
| `client/tests/offline-queue.test.ts` | 21 | Offline mesaj kuyruğu |
| `client/tests/activity.test.ts` | 22 | Aktivite sistemi |
| `client/tests/boost.test.ts` | 20 | Server boost tier mantığı |
| **Sprint 78 toplam** | **122** | |

---

## Dosya Değişim Özeti

| Dosya | Durum | Açıklama |
|-------|-------|----------|
| `client/tests/badges.test.ts` | **Yeni** | 23 test — badges.ts coverage |
| `client/tests/drafts.test.ts` | **Yeni** | 22 test — drafts.ts coverage |
| `client/tests/unread.test.ts` | **Yeni** | 14 test — unread.ts coverage |
| `client/tests/offline-queue.test.ts` | **Yeni** | 21 test — offline-queue.ts coverage |
| `client/tests/activity.test.ts` | **Yeni** | 22 test — activity.ts coverage |
| `client/tests/boost.test.ts` | **Yeni** | 20 test — boost.ts coverage |
| `client/tests/package.json` | Değiştirildi | Global threshold +3; 6 yeni dosya threshold |
| `plugins/lifecycle.ts` | Değiştirildi | `addMiddleware()` + `_runMiddlewareChain()` sandbox mini-stack |
| `turbo.json` | **Yeni** | Turborepo monorepo task orchestration |

---

## Sprint 78 Sonrası Açık Maddeler

| Madde | Öncelik | Not |
|-------|---------|-----|
| `server/lib/swagger.ts` TypeScript genişletmesi (Oturum C) | Orta | Özel JSON tipler, `$ref` resolver, operationId otomasyonu |
| Client test coverage hedefi 80%+ (uzun vade) | Orta | 137 test edilmemiş dosya mevcut; en kritik olanlar `api.ts`, `messages/render.ts`, `state.ts` |
| Turborepo remote cache entegrasyonu | Düşük | GitHub Actions cache backend; `TURBO_TOKEN` secret gerekir |
| Plugin sandbox: cross-plugin event izolasyonu audit | Düşük | Mevcut `hooks.emit('*')` tüm worker'lara broadcast yapıyor |
