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
│  → Reaktif state, form yönetimi, izole widget'lar           │
├─────────────────────────────────────────────────────────────┤
│  Köprü (Bridge Registry)                                    │
│  client/js/core/bridge-registry.ts                          │
│  → Svelte bileşenlerini lazy mount eder                     │
│  → Vanilla modüller buradan bileşen referansı alır          │
├─────────────────────────────────────────────────────────────┤
│  Servis Katmanı (Vanilla TypeScript — Svelte import yok)    │
│  socket.ts, auth.ts, state.ts, api-fetch.ts, globals.ts     │
│  → Socket.IO, API çağrıları, global state                   │
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

- `client/js/core/socket.ts`
- `client/js/core/state.ts`
- `client/js/core/auth.ts`
- `client/js/core/globals.ts`
- `client/js/app.ts`
- `client/js/core/api*.ts`
- `client/js/core/offline-queue.ts`

CI bu kuralı `check-svelte-boundary.sh` ile denetler.

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
