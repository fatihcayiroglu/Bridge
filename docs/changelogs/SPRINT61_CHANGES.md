# Sprint 61 — Bot Marketplace modüler + Svelte geçişi

## Bot Marketplace parçalama

`client/js/core/bot-marketplace.ts` → `client/js/core/bot-marketplace/`:

| Dosya | Sorumluluk |
|-------|------------|
| `types.ts` | BotEntry, PluginEntry tipleri |
| `catalog-data.ts` | Statik BOT_CATALOG, CATEGORIES |
| `bot-catalog.ts` | loadCatalog, getCatalog |
| `bot-api.ts` | API: plugins, install/uninstall |
| `bot-search.ts` | filterBots, sortBots |
| `bot-styles.ts` | injectStyles (CSS) |
| `marketplace-state.ts` | installed set, toast |
| `BotMarketplace.svelte` | Svelte UI (production) |
| `index.ts` | mount + BridgeRegistry |

## Channel Perms Svelte (aşama 1)

- `channel-perms/ChannelPermsModal.svelte` — modal shell (başlık, sekmeler, a11y)
- `channel-perms/channel-perms-svelte.ts` — mountChannelPermsShell()
- Matris içeriği hâlâ `modal-core.ts` vanilla (shell içine enjekte edilebilir)

## Önceki sprint maddeleri (Sprint 60 zip üzerinde)

- Client testleri → `.test.ts` (31 dosya)
- Swagger %100 route kapsamı, CI eşiği %90
- Token cache LRU
- federation-inbox-dm.test.ts
- cleanupUploads 10 dk grace
- Express 5 (root package.json)
