# Frontend Mimari Rehberi

Sprint 108 — ADR-0008 uygulaması

Bu belge Bridge frontend'inin katmanlarını, Svelte/vanilla TS sınırlarını ve
yeni modül eklerken uyulacak kuralları açıklar.

---

## Katman Modeli

```
┌─────────────────────────────────────────────────────────────┐
│  UI Katmanı (Svelte bileşenleri)                            │
│  SettingsModal, ChannelList, BotMarketplace, ...            │
│  SocketManager, MessageLoader, AppState (renderless)        │
│  → Reaktif state, form yönetimi, izole widget'lar           │
├─────────────────────────────────────────────────────────────┤
│  Köprü (Bridge Registry)                                    │
│  client/js/core/bridge-registry.ts                          │
│  → Svelte bileşenlerini lazy mount eder                     │
│  → Vanilla modüller buradan bileşen referansı alır          │
├─────────────────────────────────────────────────────────────┤
│  Servis Katmanı (Vanilla TypeScript — Svelte import yok)    │
│  globals, state, api-fetch, api-error, auth-compat,         │
│  outbox-store; local-first/*, messages/message-format       │
│  → API çağrıları, oturum, yerel-öncelikli depolama          │
├─────────────────────────────────────────────────────────────┤
│  Platform (Tarayıcı / Electron / Capacitor)                 │
└─────────────────────────────────────────────────────────────┘
```

---

## Svelte ne zaman kullanılır?

Bir UI parçası şu kriterlerin **en az 2'sini** karşılıyorsa Svelte bileşeni:

1. 3+ yerel state değişkeni yönetecek
2. Kardeş bileşenlerle reaktif veri paylaşımı gerektirecek
3. 200+ satır vanilla DOM kodu gerektirecek
4. İzole test edilmesi gereken widget

Servis kodu, event binding, socket handler → vanilla TS.

---

## Kesin Sınır: Servis Katmanı

Aşağıdaki dosyalar asla Svelte import etmez:

- `client/js/app.ts`
- `client/js/core/globals.ts`
- `client/js/core/state.ts`
- `client/js/core/bridge-registry.ts`
- `client/js/core/api-fetch.ts`
- `client/js/core/api-error.ts`
- `client/js/core/auth-compat.ts`
- `client/js/core/outbox-store.ts`

Framework'ten bağımsız katman da Svelte import etmez. Dizin girdisinde içindeki
her kaynak dosya (sonradan eklenenler dahil) denetlenir ve dizine `.svelte` /
`.svelte.ts` dosyası eklenemez:

- `client/js/core/local-first/`
- `client/js/core/messages/message-format.ts`

`.svelte` dosyaları bu listeye girmez; tanım gereği Svelte'dirler. Soket
bağlantısı bugün `SocketManager.svelte`'te, mesaj yükleme `MessageLoader.svelte`'te,
uygulama mesaj durumu `AppState.svelte`'tedir (işaretlemesi tek satır olan,
renderless bileşenler). Eski listedeki `socket.ts`, `auth.ts` ve `offline-queue.ts`
artık yok: kimlik doğrulama işlevleri (`readToken`, `logout`, …) `auth-compat.ts`'te,
kalıcı giden mesaj kuyruğu `outbox-store.ts`'tedir. Eski `api*.ts` kalıbı
`api-error-toast-svelte.ts` mount shim'ini de kapsıyordu; liste bu yüzden açık
dosya adları kullanır.

CI bu kuralı `scripts/check-svelte-boundary.sh` ve TypeScript sözdizimi ayrıştırıcısı
`scripts/check-svelte-imports.cjs` ile denetler (`quality-gate.yml` →
`typecheck-build`). Listelenen bir dosya ya da dizin yoksa betik **başarısız**
olur; eskiden sessizce atlıyordu ve 8 girdinin 3'ü silinmişken kapı yeşil
kalıyordu. Kontrol doğrudan importlara bakar: `from 'svelte'`, `from 'svelte/…'`,
`from './X.svelte'`, `.svelte.ts` modülleri, `import '…'`, `import('…')` ve
`require('…')`. Yorumlar ve satır sonları importu gizlemez; hesaplanan dinamik
importlar doğrulanamadığı için reddedilir. Listeyi değiştirirken bu bölümü de güncelleyin:
`scripts/check-svelte-boundary.test.js` (`npm run test:release-integrity`) ikisinin
aynı olduğunu doğrular.

---

## Svelte bileşeni yazma adımları

```bash
# 1. Dosya oluştur
client/js/core/<feature>/<ComponentName>.svelte

# 2. BridgeRegistry'ye kaydet (bridge-registry.ts)
BridgeRegistry.register('<component-key>', ComponentName);

# 3. Vanilla modülden kullan (BridgeRegistry üzerinden)
import { BridgeRegistry } from './bridge-registry.js';
BridgeRegistry.mount('<component-key>', targetEl, props);
```

---

## Test stratejisi

| Modül türü | Test framework |
|------------|----------------|
| Vanilla TS | Jest + jsdom |
| Svelte bileşeni | `@testing-library/svelte` + Vitest |
| Socket handler | Jest + mock Socket.IO |
| E2E | Playwright |

---

## Mevcut Svelte bileşenlerinin durumu

| Bileşen | Svelte versiyonu | Test kapsamı |
|---------|-----------------|--------------|
| SettingsModal.svelte | 5 (Runes) | settings-modal.test.ts |
| ChannelList.svelte | 5 (Runes) | channel-list.test.ts |
| BotMarketplace.svelte | 5 (Runes) | bot-marketplace.test.ts |
| ChannelPermsModal.svelte | 5 (Runes) | channel-perms-modal-state.test.ts |
| ServerSettingsModal.svelte | 5 (Runes) | server-settings.test.ts |

---

## İlgili ADR'ler

- ADR-0002: Svelte vs Vue orijinal karar
- ADR-0008: Bu mimari stratejinin gerekçesi
- [ADR-0014](ADR-0014-cross-platform-client-architecture.md): Svelte 5 web, Electron masaüstü, P8'de React Native mobil ve paylaşılan TypeScript çekirdek yönü; ölçülen bağımlılıklar (`node scripts/measure-client-coupling.cjs`). Not: `scripts/check-svelte-boundary.sh` listelenen ama artık var olmayan `core/socket.ts`, `core/auth.ts` ve `core/offline-queue.ts` dosyalarını atlıyor; servis mantığının bir kısmı artık `SocketManager.svelte`, `MessageLoader.svelte` ve `AppState.svelte` içinde.
