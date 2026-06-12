# Sprint 33 Değişiklikleri

## window.* Köprü Temizliği

### Yeni: `client/js/core/bridge-registry.ts`
Modüller arası fonksiyon paylaşımı için merkezi kayıt defteri.
`window.foo = function(){}` yerine `BridgeRegistry.register('foo', fn)` kullanılır.
HTML'de `onclick="window.foo()"` yerine `data-bridge-action="foo"` kullanılır.

---

### `client/js/federation-ui.ts`
- `window._federationStats` → modül-seviyesi `_federationStatsCache` değişkeni
- `window.renderServerList` wrap → `BridgeRegistry.wrap('renderServerList', ...)`
- `window.showMemberProfile` wrap → `BridgeRegistry.register('showMemberProfile', ...)`
- `window.selectServer` wrap → `BridgeRegistry.register('selectServer', ...)`
- `window.API` → `getAPI()` (globals.ts)
- `window.location.hostname` → `location.hostname`

### `client/js/federation-integrations.ts`
- federation-ui.ts ile aynı temizlikler uygulandı (duplicate modül)

### `client/js/threads.ts`
- `window.openThread` → `BridgeRegistry.register('openThread', ...)`
- `window.closeThread` → `BridgeRegistry.register('closeThread', ...)`
- `window.sendThreadMessage` → `BridgeRegistry.register('sendThreadMessage', ...)`
- `window.translateThreadMessage` → `BridgeRegistry.register('translateThreadMessage', ...)`
- `window.deleteThreadMessage` → `BridgeRegistry.register('deleteThreadMessage', ...)`
- `window.handleThreadKey` → `BridgeRegistry.register('handleThreadKey', ...)`
- `window._bindThreadSocketEvents` → `BridgeRegistry.register('_bindThreadSocketEvents', ...)`
- `window.currentUser.*` → `BridgeRegistry.call('getCurrentUser')`

### `client/js/slash.ts`
- `window.loadBotSlashCommands` → `BridgeRegistry.register(...)`
- `window.handleSlashInput` → `BridgeRegistry.register(...)`
- `window.handleSlashKey` → `BridgeRegistry.register(...)`
- `window.executeSlashCommand` → `BridgeRegistry.register(...)`
- `window.currentChannel/_server/_me` → `BridgeRegistry.call(...)`
- `window.innerHeight` korundu (gerçek DOM özelliği)

### `client/js/mobile.ts`
- `window.closeMobilePanels` → `BridgeRegistry.register(...)`
- `window.mobileNav` → `BridgeRegistry.register(...)`
- `window.selectChannel` wrap → `BridgeRegistry.register(...)`
- `window.toggleMemberList` wrap → `BridgeRegistry.register(...)`
- `window.setMobileNavPip` → `BridgeRegistry.register(...)`
- `window.innerWidth/Height/matchMedia/addEventListener` korundu (DOM API)

### `client/js/plugin-marketplace-page.ts`
- `window.closeMktModal/showPluginDetails/showBotDetails/rateBot` → `BridgeRegistry.register(...)`
- `window.installBotFlow/installBotWithServer/loadMarketplace` → `BridgeRegistry.register(...)`
- `window.BRIDGE_API` → `(window as any).BRIDGE_API` (sunucu enjekte, kaçınılmaz)
- `window.location.origin` → `location.origin`

### `client/js/admin.ts`
- `window._aut` inline debounce → CustomEvent `bridge:admin-search` + modül seviyesi timer
- `window.devicePixelRatio` korundu (DOM API)

### `client/js/core/discord-import.ts`
- `window.API` → `getAPI()`
- `window.location.hash` → `location.hash`
- `window.DiscordImport` → `BridgeRegistry.register('DiscordImport:open', ...)`
- `window.openDiscordImport` → `BridgeRegistry.register('openDiscordImport', ...)`
- Geriye-dönük uyumluluk: `globalThis.openDiscordImport` (HTML'den çağrılır)

### `client/index.html`
- 5 adet `onclick="window.*"` → `data-bridge-action` niteliğine çevrildi:
  - `window.BridgeE2E?.openE2ESettings()` → `data-bridge-action="BridgeE2E:openSettings"`
  - `window.innerWidth + window.BridgeSemanticSearch` → `data-bridge-action="toggleSearch"`
  - `window._dmCallVoice&&window._dmCallVoice()` → `data-bridge-action="dmCallVoice"`
  - `window._dmCallVideo&&window._dmCallVideo()` → `data-bridge-action="dmCallVideo"`
  - `window.sendDm||sendDm` → `data-bridge-action="sendDmOrGroup"`
- Sprint 33 init `<script>` bloğu eklendi: `data-bridge-action` click dispatcher

### Korunan (Silinmeyen) `window.*` Kullanımları
Bunlar köprü değil, gerçek tarayıcı DOM API'leridir:
- `window.addEventListener(...)` — olay dinleme
- `window.innerWidth/innerHeight` — ekran boyutu
- `window.matchMedia(...)` — medya sorgusu
- `window.devicePixelRatio` — piksel yoğunluğu
- `window.location.href` — yönlendirme (SW mesajı)
- `window.hcaptcha/turnstile/Sentry` — üçüncü taraf SDK
