# Bridge Bot SDK — Release Notes

Format [Keep a Changelog](https://keepachangelog.com/) standardına uygundur.
Versiyonlama [Semantic Versioning](https://semver.org/) kurallarını izler.

---

## [2.0.0] — 2026-05-08

### 🚨 Breaking Changes
- `main` artık `dist/index.js` (derlenmiş çıktı) — `npm run build` gereklidir.
- `module.exports` → named exports. CommonJS: `const { BridgeBot } = require('bridge-bot-sdk');`
- `BotStore` artık generic: `new BotStore<MyType>()` (varsayılan `BotStore<unknown>`).
- `EmbedBuilder.addField(name, value, inline?)` → `addField(name, value, { inline? })`.

### Eklendi
- **Tam TypeScript kaynak kodu** — `bot-sdk/src/index.ts` (816 satır, 24 interface, 6 class).
- **Tip dışa aktarımı** — `dist/index.d.ts` ile IDE otomatik tamamlama desteği.
- 24 yeni `export interface`: `BotOptions`, `BotMessage`, `BotEvents`, `CommandContext`,
  `ModalContext`, `InteractionData`, `RateLimitData`, `ActionRow`, `Button`, `ServerMember` vb.
- `sendInteractiveMessage(channelId, content, components)` — buton/bileşen desteği.
- `BotEvents` interface — EventEmitter tam tip güvencesiyle.
- `PaginationHelper<T>` artık generic.
- `tsconfig.json` — `strict: true`, `noImplicitAny`, `noImplicitReturns` dahil.

### Değişti
- `SDK_VERSION`: `1.2.0` → `2.0.0`.
- `_api()` artık generic `_api<T>()`.
- Tüm private alanlar `private` / `private readonly` ile işaretlendi.

### Düzeltildi
- `setTimeout` leak: `clearTimeout` connect() promise'te garantilendi.

---

## [1.2.0] — 2026-05-07

### Eklendi
- `_contextCommands` ve `_modalHandlers` Map'leri constructor'da başlatılıyor (lazy init kaldırıldı).
- Gereksiz `?.` optional chain'ler temizlendi.

### Değişti
- Minimum Node.js gereksinimi `>=18` → `>=22` (LTS).

### Düzeltildi
- Yorum satırındaki versiyon `v1.1.0` → `v1.2.0` olarak güncellendi.

---

## [1.1.0] — 2026-04-23

### Eklendi
- `bot.version` property — SDK versiyonunu dışarıya açar.
- `bot.getVersion()` — bağlı sunucunun Bridge sürümünü döner.
- `version_mismatch` event — sunucu sürümü SDK ile uyumsuzsa tetiklenir.

### Değişti
- Minimum Node.js gereksinimi `>=16` → `>=18` (LTS).

### Düzeltildi
- `bot.disconnect()` ardından `reconnect` event'inin yanlış tetiklenmesi giderildi.

---

## [1.0.0] — 2026-01-15

### Eklendi
- `BridgeBot` ana sınıfı: `connect()`, `disconnect()`, `send()`, `reply()`.
- Event sistemi: `message`, `ready`, `error`, `disconnect`, `reconnect`.
- REST wrapper: `bot.api.get()`, `bot.api.post()`, `bot.api.patch()`, `bot.api.delete()`.
- Örnek botlar: `welcomebot`, `modbot`, `pollbot`, `musicbot`.
- Komut ayrıştırıcı: prefix bazlı (`!`, `/`) ve slash command desteği.
- Rate-limit farkındalığı: `Retry-After` header'ını otomatik bekler.
- Token refresh akışı: 401'de otomatik yeniden bağlanma.
- Heartbeat / ping-pong izleme: 30 sn timeout sonrası otomatik reconnect.
