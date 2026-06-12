# Sprint 57 Değişiklikleri

## Genel Bakış

Sprint 56 backlog'undaki **2 kırmızı öncelikli iş** tamamlandı:

1. **`settings-modal.ts` Vanilla JS modal kaldırıldı** — 774 → 50 satır
2. **`client/tests/helpers/setup.js` → `setup.ts` migrate edildi**

---

## PHASE 1 — `settings-modal.ts` Vanilla JS Kodu Kaldırıldı

### Değişiklik

| Metrik | Önce | Sonra |
|--------|------|-------|
| Satır sayısı | 774 | 50 |
| Fonksiyon sayısı | ~35 | 1 |
| Import sayısı | 8 | 1 |

**Kaldırılan fonksiyonlar (35 adet):**

`openSettings`, `saveSettings`, `loadVoiceDeviceSettings`, `_updateProfilePreview`,
`_loadAIStatusInSettings`, `_loadE2EStatusInSettings`, `_loadActivityInSettings`,
`applyMicChange`, `applySpeakerChange`, `applyCameraChange`, `_applyVoiceDevicesToUI`,
`_startMicTest`, `_stopMicTest`, `_getAudioPrefs`, `_saveAudioPrefs`,
`_applyBitrateToAllPeers`, `applyAudioQuality`, `applyAudioCodec`, `applyAudioStereo`,
`applyAudioConstraint`, `_audioQualityStatusUpdate`, `_audioQualityUiSync`,
`_updateToggleTrack`, `_getSSPrefs`, `_saveSSPrefs`, `applyScreenSharePrefs`,
`applyScreenShareBitrateNow`, `_ssPresetLabel`, `_ssQualityStatusUpdate`, `_ssQualityUiSync`,
`_pttUiSync`, `_nsUiSync`, `_nsUpdateToggleTrack`, `applyNSToggle`, `applyNSMode`,
`_nsReplaceVoiceTrack`, `_nsStartLevelMeter`, `_nsStopLevelMeter`,
`saveBannerColor`, `saveBadge`, `_initChatBgPanel`

**Kalan:** Yalnızca `_openSettingsSvelte` + `BridgeRegistry.register` kaydı.

**Not:** Sprint 56'da `openSettings()` Vanilla JS fallback olarak tutulmuştu.
Sprint 57'de Svelte geçişi production'da doğrulandığından fallback kaldırıldı.
Svelte yüklenemezse artık `console.error` loglanır — sessiz degrade olmaz.

---

## PHASE 2 — `client/tests/helpers/setup.js` → `setup.ts`

### Değişiklikler

- `setup.js` kaldırıldı
- `setup.ts` oluşturuldu — tüm `global.*` atamaları TypeScript `declare global` bloğu ile tiplendi
- `client/tests/package.json` → `setupFiles: ["./helpers/setup.ts"]` güncellendi

### Tip eklemeleri

| Global | Tip |
|--------|-----|
| `io` | `jest.Mock` |
| `fetch` | `jest.Mock` |
| `socket` | `{ emit, on, off: jest.Mock; connected: boolean }` |
| `escHtml` | `(s: string) => string` |
| `safeFileUrl` | `(url: unknown) => string` |
| `cssColor` | `(v: unknown) => string` |
| `_blockedUserIds` | `Set<string>` |
| `_channelScrollPos` | `Record<string, number>` |
| `clientConfig` | `Record<string, unknown>` |
| `console.warn` override | `(...args: unknown[]) => void` |

**Server tarafı helpers** (`mocks.ts`, `mockDb.ts`, `index.ts`) Sprint 50-56'da zaten `.ts` idi — değişiklik yok.

---

## Özet

| Kategori | Değişiklik |
|----------|------------|
| `settings-modal.ts` | 774 → 50 satır (-724 satır, -35 fonksiyon) |
| Vanilla JS modal | Tamamen kaldırıldı |
| `setup.js` | Kaldırıldı |
| `setup.ts` | Oluşturuldu — tam tip güvenliği |
| `package.json` | `setupFiles` güncellendi |
| Kalan `.test.js` | 0 ✅ |
| Kalan `.js` helper | 0 ✅ |

## Sprint 58 Backlog

| Öncelik | İş |
|---------|-----|
| 🟡 | Swagger: `federation/activitypub.ts`, `sso.ts`, `serverTemplates.ts` (17 route) |
| 🟡 | CI'da `check-swagger-coverage.ts --ci` (eşik: %60) |
| 🟡 | mediasoup `createWebRtcTransport` opts → `WebRtcTransportConfig` tipi |
| 🟢 | `asyncHandler.ts` import kontrolü (kaldırılmış mı?) |
