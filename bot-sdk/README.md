# Bridge Bot SDK

Bridge Chat için resmi bot geliştirme kütüphanesi.

## Kurulum

```bash
npm install bridge-bot-sdk
```

## Hızlı Başlangıç

```js
const { BridgeBot } = require('bridge-bot-sdk');

const bot = new BridgeBot({
  token:     'brg_bot_xxxxxxxxxxxx',
  serverUrl: 'https://bridge.example.com',
  debug:     true,
});

bot.on('ready', info => console.log(`✅ ${info.username} bağlandı`));

bot.command('ping', {
  description: 'Ping komutunu işle',
  handler: async ctx => {
    // Komutu çağıran mesaja yanıt (POST /api/v1/bots/interactions/:id/reply).
    await ctx.reply('🏓 pong');
  },
});

await bot.connect(); // kimliği doğrular + slash metadata'yı otomatik kaydeder
```

## İçindekiler

- [Komutlar](#komutlar)
- [Eventler](#eventler)
- [Mesajlaşma API](#mesajlaşma-api)
- [MessageBuilder](#messagebuilder)
- [EmbedBuilder](#embedbuilder)
- [ButtonBuilder](#buttonbuilder)
- [PaginationHelper](#paginationhelper)
- [BotStore](#botstore)
- [Moderasyon](#moderasyon)
- [Modal (Form)](#modal-form)
- [Hata Yönetimi](#hata-yönetimi)
- [Tam Örnek](#tam-örnek--moderasyon-botu)

---

## Komutlar

```js
bot.command('yardim', {
  description: 'Yardım komutunu işle',
  usage: '/yardim [konu]',
  handler: async ctx => {
    console.log('yardim', ctx.args);
  },
});
// connect() registered slash metadata'yı /api/v1/bots/me/slash-commands'e yazar.
```

### Context Menu (Sağ-tık)

```js
bot.contextCommand('Kullanıcı Bilgisi', 'USER_COMMAND', async ctx => {
  console.log('target user', ctx.targetUserId);
});
await bot.registerContextCommands();
```

---

## Eventler

| Event | Payload |
|-------|---------|
| `ready` | `{ username, _id }` |
| `disconnect` | `reason: string` |
| `reconnect` | — |
| `message` | Hedef bota kayıtlı slash komutu eşleştiğinde `BotMessage` |
| `interaction` | Bota yönlendirilen context/component interaction |
| `messageEdit` / `messageDelete` / `reaction` | **Şu an server tarafından bot odasına yayınlanmıyor** |
| `memberJoin` / `memberLeave` | **Şu an server tarafından bot odasına yayınlanmıyor** |
| `commandError` | `{ command, error, ctx }` |
| `rateLimit` | `{ path, method, retryAfter, retryCount }` |

`rateLimit` tetiklendiğinde SDK otomatik bekler ve yeniden dener (maks 3 kez). Gözlemlemek için:

```js
bot.on('rateLimit', ({ path, retryAfter }) => {
  console.warn(`Rate limit: ${path} — ${retryAfter}s bekleniyor`);
});
```

---

## Mesajlaşma API

### Komuta yanıt — desteklenir

Bir botun yazabildiği tek mesaj, bir kullanıcının çağırdığı slash komutuna yanıttır:
`ctx.reply(content)` ya da `bot.replyToInteraction(invocationMessageId, content)`.
Sunucu her yanıtta şunları yeniden doğrular:

| Koşul | Reddedilirse (`BridgeApiError.code`) |
|-------|--------------------------------------|
| Mesaj bu botun kayıtlı bir komutunu çağırıyor | `not_invoked` (403) |
| Çağrı en fazla 15 dakika önce yapıldı | `interaction_expired` (403) |
| Bot o sunucuda kurulu | `not_installed` (403) |
| Kurulumda `messages:reply` izni verildi (botun kendi sunucusunda her zaman var) | `scope_required` (403) |
| Çağıran kullanıcının o kanalda `USE_BOT_COMMANDS` yetkisi var | `not_invoked` (403) |
| Sunucunun AutoMod kuralları yanıtı engellemiyor (botlar rol muafiyeti alamaz) | `automod_blocked` (403) |
| Aynı çağrıya en fazla 5 yanıt | `reply_limit` (429) |
| Metin, 1–2000 karakter | `content required` / `content too long` (400) |

Yanıt kanalda **BOT** etiketiyle görünür ve çağrı mesajına bağlanır. Bot yanıtı mention
bildirimi, giden webhook, plugin hook ya da sunucular arası köprü tetiklemez.

```js
bot.command('zar', {
  description: 'Zar at',
  handler: async ctx => {
    try {
      await ctx.reply(`🎲 ${1 + Math.floor(Math.random() * 6)}`);
    } catch (err) {
      if (err.name === 'BridgeApiError' && err.code === 'scope_required') {
        console.warn('Bu sunucu yanıt iznini vermedi:', ctx.serverId);
      } else throw err;
    }
  },
});
```

Context menu ve modal etkileşimleri bir çağrı mesajı taşımaz; onların `ctx.reply`'ı
`sendMessage` ile aynı şekilde desteklenmez.

### Serbest mesaj yazma — desteklenmez

> Kanal mesajı oluşturma/düzenleme/silme/reaksiyon/geçmiş authority'si kullanıcı
> principal'ına bağlıdır. SDK bu rotalara `Authorization: Bot` gönderip 401'i gizlemek
> yerine aşağıdaki yüzeylerde `BridgeUnsupportedError` fırlatır.
>
> `sendMessage`, `editMessage`, `deleteMessage`, `addReaction`, `getMessages` ve
> `sendInteractiveMessage` için bot-principal policy tamamlanana kadar davranış budur.

```js
try {
  await bot.sendMessage(channelId, 'Merhaba!');
} catch (err) {
  if (err.name === 'BridgeUnsupportedError') console.error(err.message);
}
```

---

## MessageBuilder

```js
const { MessageBuilder } = require('bridge-bot-sdk');

const msg = new MessageBuilder()
  .title('📊 İstatistikler')
  .divider()
  .field('Üye', '1,234')
  .field('Mesaj/Gün', '~450')
  .text('Son güncelleme: az önce')
  .build();

await bot.sendMessage(channelId, msg);
```

---

## EmbedBuilder

Discord embed benzeri zengin kart — Bridge markdown formatı kullanır.

```js
const { EmbedBuilder } = require('bridge-bot-sdk');

const embed = new EmbedBuilder()
  .setTitle('🎉 Duyuru')
  .setDescription('Büyük değişiklikler geliyor!')
  .addField('Tarih', '1 Mayıs 2025')
  .addField('Yer', '#genel', true)   // true = inline
  .setFooter('Bridge Bot • az önce')
  .build();

await bot.sendMessage(channelId, embed);
```

---

## ButtonBuilder

```js
const { ButtonBuilder } = require('bridge-bot-sdk');

const buttons = new ButtonBuilder()
  .addButton({ customId: 'onayla', label: '✅ Onayla', style: 'success'   })
  .addButton({ customId: 'reddet', label: '❌ Reddet', style: 'danger'    })
  .addButton({ customId: 'bekle',  label: '⏳ Bekle',  style: 'secondary' })
  .build();

// Tıklamayı dinle
bot.on('interaction', async data => {
  if (data.type === 'button' && data.customId === 'onayla') {
    await bot.sendMessage(data.channelId, '✅ Onaylandı!');
  }
});
```

Buton stilleri: `primary` | `secondary` | `success` | `danger` | `link`

---

## PaginationHelper

```js
const { PaginationHelper } = require('bridge-bot-sdk');

const items = Array.from({ length: 50 }, (_, i) => `Madde ${i + 1}`);

const pager = new PaginationHelper(items, {
  pageSize:  10,
  title:     '📋 Liste',
  formatter: (item, i) => `${i + 1}. ${item}`,
});

const page = pager.getPage(0);
await bot.sendMessage(channelId, page.content);
// page.hasNext  → boolean
// page.hasPrev  → boolean
// page.current  → number (0-indexed)
// page.total    → toplam sayfa sayısı
```

---

## BotStore

```js
const { BotStore } = require('bridge-bot-sdk');
const store = new BotStore();

store.set('anahtar', { count: 3 });
store.get('anahtar');        // { count: 3 }
store.has('anahtar');        // true
store.delete('anahtar');
store.clear();
```

---

## Moderasyon

Bot principal için rol hiyerarşisi ve moderasyon authority policy'si henüz tanımlı
olmadığından `kick`, `ban`, `timeout`, `getMembers`, `addRole` ve `removeRole`
şu an **açıkça unsupported** durumdadır. Bunlar var olan user-auth endpointlerine
bot tokenı gönderip sahte destek göstermez.

---

## Modal (Form)

Shipping client `bot:showModal` olayını tüketmediği için `showModal()` şu an
`BridgeUnsupportedError` fırlatır. `onModalSubmit()` handler kaydı korunur; modal
transportu gerçekten shipping client'a bağlanmadan destekleniyor gibi ilan edilmez.

---

## Hata Yönetimi

```js
bot.on('commandError', ({ command, error, ctx }) => {
  console.error(`/${command}:`, error.message);
  // Yanıt reddi BridgeApiError'dır: error.status + error.code (ör. 'reply_limit').
  console.error(ctx.channelId, error);
});
```

---

## Tam Örnek — Moderasyon Botu

```js
const { BridgeBot, BotStore, EmbedBuilder } = require('bridge-bot-sdk');

const bot   = new BridgeBot({ token: process.env.BOT_TOKEN, serverUrl: process.env.BRIDGE_URL });
const store = new BotStore();

bot.on('ready', info => console.log(`✅ ${info.username} hazır`));

bot.command('uyar', {
  description: 'Kullanıcıya uyarı ver',
  handler: async ctx => {
    const id  = ctx.args[0]?.replace(/[<@>]/g, '');
    const seb = ctx.args.slice(1).join(' ') || 'Sebep yok';
    if (!id) return ctx.reply('/uyar @kullanıcı [sebep]');

    const key = `warn_${ctx.serverId}_${id}`;
    const n   = (store.get(key) || 0) + 1;
    store.set(key, n);

    await ctx.reply(new EmbedBuilder()
      .setTitle('⚠️ Uyarı')
      .addField('Kullanıcı', `<@${id}>`)
      .addField('Sebep', seb)
      .addField('Toplam', `${n}/3`)
      .build()
    );

    if (n >= 3) {
      await bot.timeout(ctx.serverId, id, 60, '3 uyarı limiti');
      store.delete(key);
    }
  },
});

bot.connect();
```

---

## Konfigürasyon

| Seçenek | Tip | Varsayılan | Açıklama |
|---------|-----|------------|----------|
| `token` | string | — | Bot token (**zorunlu**) |
| `serverUrl` | string | `http://localhost:3001` | Bridge sunucu URL'i |
| `debug` | boolean | `false` | Detaylı log |

**Gereksinimler:** Node.js ≥ 18 · **Lisans:** MIT

---

## API Referansı

### `BridgeBot`

Ana sınıf. `EventEmitter`'dan türetilmiştir.

#### Constructor

```ts
new BridgeBot(options: BotOptions)
```

| Parametre | Tip | Zorunlu | Açıklama |
|-----------|-----|---------|----------|
| `token` | `string` | ✅ | Bot token (`brg_bot_...`) |
| `serverUrl` | `string` | ❌ | Bridge sunucu URL'i (varsayılan: `http://localhost:3001`) |
| `debug` | `boolean` | ❌ | Konsol log aktif (varsayılan: `false`) |

---

#### Bağlantı

| Metod | İmza | Açıklama |
|-------|------|----------|
| `connect()` | `(): Promise<BridgeBot>` | Sunucuya bağlan, `ready` event'i bekle |
| `disconnect()` | `(): void` | Bağlantıyı kapat |
| `isConnected` | `get: boolean` | Bağlantı durumu |

---

#### Komutlar

| Metod | İmza | Açıklama |
|-------|------|----------|
| `command(name, def)` | `(name: string, def: CommandDefinition): this` | `/komut` tanımla |
| `registerSlashCommands()` | `(): Promise<void>` | Slash metadata'yı kaydet (`connect()` otomatik çağırır) |
| `registerContextCommands()` | `(): Promise<void>` | Context menu komutlarını API'ye kaydet |
| `showModal(userId, modal)` | `(userId: string, modal: ModalDefinition): void` | **Unsupported** — shipping client transportu yok |
| `onModalSubmit(customId, handler)` | `(customId: string, handler): this` | Modal submit handler |

**`CommandDefinition`:**
```ts
{
  description: string;  // Komut açıklaması
  usage?: string;       // Kullanım bilgisi  
  handler: (ctx: CommandContext) => Promise<void>;
}
```

**`CommandContext`:**
```ts
{
  message:   BotMessage;
  channelId: string;
  serverId:  string;
  userId:    string;
  args:      string[];          // komuttan sonraki kelimeler
  reply:     (content: string) => Promise<BotMessage | null>;  // replyToInteraction(message._id, content)
  react:     (emoji: string)   => Promise<void>;                // unsupported
}
```

---

#### Mesajlaşma

| Metod | İmza | Dönüş |
|-------|------|-------|
| `replyToInteraction` | `(invocationMessageId, content): Promise<BotMessage>` | Çağrılan komuta yanıt ver (koşullar: [Mesajlaşma API](#mesajlaşma-api)) |
| `sendMessage` | `(channelId, content): Promise<BotMessage \| null>` | Mesaj gönder  **Unsupported (bot principal policy pending)** |
| `editMessage` | `(channelId, messageId, content): Promise<BotMessage \| null>` | Mesajı düzenle  **Unsupported (bot principal policy pending)** |
| `deleteMessage` | `(channelId, messageId): Promise<null>` | Mesajı sil  **Unsupported (bot principal policy pending)** |
| `addReaction` | `(channelId, messageId, emoji): Promise<null>` | Reaksiyon ekle  **Unsupported (bot principal policy pending)** |
| `getMessages` | `(channelId, limit?): Promise<BotMessage[]>` | Mesajları getir (max 100)  **Unsupported (bot principal policy pending)** |
| `sendInteractiveMessage` | `(channelId, content, components): Promise<BotMessage \| null>` | Butonlu mesaj gönder  **Unsupported (bot principal policy pending)** |

**`BotMessage`:**
```ts
{
  _id:          string;
  channelId:    string;
  serverId:     string;
  userId:       string;
  content:      string;
  createdAt:    number;    // Unix ms
  author?:      { _id: string; username: string; displayName?: string };
  attachments?: Attachment[];
}
```

---

#### Moderasyon

| Metod | İmza | Açıklama |
|-------|------|----------|
| `kick(serverId, userId, reason?)` | `(): Promise<null>` | Kullanıcıyı at  **Unsupported (bot principal policy pending)** |
| `ban(serverId, userId, reason?)` | `(): Promise<null>` | Kullanıcıyı yasakla  **Unsupported (bot principal policy pending)** |
| `timeout(serverId, userId, minutes?, reason?)` | `(): Promise<null>` | Kullanıcıyı sustur  **Unsupported (bot principal policy pending)** |

---

#### Üye Yönetimi

| Metod | İmza | Açıklama |
|-------|------|----------|
| `getMembers(serverId)` | `(): Promise<ServerMember[]>` | Üye listesini getir  **Unsupported (bot principal policy pending)** |
| `addRole(serverId, userId, roleId)` | `(): Promise<null>` | Rol ata  **Unsupported (bot principal policy pending)** |
| `removeRole(serverId, userId, roleId)` | `(): Promise<null>` | Rol kaldır  **Unsupported (bot principal policy pending)** |

---

#### Eventler (`bot.on(event, handler)`)

| Event | Payload | Tetiklenme |
|-------|---------|------------|
| `ready` | `BotInfo` | Bağlantı ve kimlik doğrulama tamamlandı |
| `message` | `BotMessage` | Bu bota kayıtlı slash komutu eşleşti |
| `messageEdit` | `MessageEditData` | **Şu an bot odasına yayınlanmıyor** |
| `messageDelete` | `MessageDeleteData` | **Şu an bot odasına yayınlanmıyor** |
| `reaction` | `ReactionData` | **Şu an bot odasına yayınlanmıyor** |
| `memberJoin` | `MemberEventData` | **Şu an bot odasına yayınlanmıyor** |
| `memberLeave` | `MemberEventData` | **Şu an bot odasına yayınlanmıyor** |
| `interaction` | `InteractionData` | Buton/select tıklandı |
| `disconnect` | `string` (reason) | Bağlantı koptu |
| `reconnect` | — | Yeniden bağlandı |
| `rateLimit` | `RateLimitData` | Rate limit aşıldı |
| `deprecationWarning` | `{ path, method, successor }` | Eski API endpoint kullanıldı |
| `commandError` | `{ command, error, ctx }` | Komut handler hata fırlattı |

---

### `MessageBuilder`

Markdown tabanlı mesaj oluşturucu.

```ts
const msg = new MessageBuilder()
  .title('Başlık')
  .text('Açıklama metni')
  .field('Alan', 'Değer')
  .divider()
  .code('console.log("merhaba")', 'js')
  .build(); // string döner
```

| Metod | Açıklama |
|-------|----------|
| `.title(text)` | Kalın başlık ekle |
| `.text(text)` | Normal metin ekle |
| `.field(name, value)` | `**İsim:** Değer` satırı |
| `.divider()` | Yatay çizgi |
| `.code(text, lang?)` | Kod bloğu |
| `.build()` | `string` döner |

---

### `EmbedBuilder`

Discord embed benzeri zengin kart.

```ts
const embed = new EmbedBuilder()
  .setTitle('🎉 Başlık')
  .setDescription('Açıklama')
  .addField('Alan', 'Değer')
  .addField('Inline', 'Değer', { inline: true })
  .setFooter('Bot Adı • az önce')
  .build(); // string döner
```

| Metod | Açıklama |
|-------|----------|
| `.setTitle(text)` | Başlık |
| `.setDescription(text)` | Ana metin |
| `.addField(name, value, opts?)` | Alan ekle. `opts.inline: true` ile yanyana |
| `.setFooter(text)` | Alt bilgi |
| `.setColor(hex)` | Renk (gelecekte desteklenecek) |
| `.build()` | `string` döner |

---

### `ButtonBuilder`

Buton listesi oluşturur.

```ts
const row = new ButtonBuilder()
  .addButton({ customId: 'onayla', label: '✅ Onayla', style: 'success' })
  .addButton({ customId: 'reddet', label: '❌ Reddet', style: 'danger' })
  .build(); // ActionRow döner

await bot.sendInteractiveMessage(channelId, 'Onaylıyor musunuz?', [row]);

bot.on('interaction', async data => {
  if (data.customId === 'onayla') { /* ... */ }
});
```

**Buton stilleri:** `primary` · `secondary` · `success` · `danger` · `link`

---

### `BotStore<V>`

Basit anahtar-değer bellek deposu.

```ts
const store = new BotStore<number>();
store.set('counter', 0);
store.set('counter', (store.get('counter') ?? 0) + 1);
store.has('counter');   // true
store.delete('counter');
store.clear();
```

---

### `PaginationHelper<T>`

Uzun listeleri sayfalara böler.

```ts
const pager = new PaginationHelper(items, {
  pageSize: 10,
  title: '📋 Üyeler',
  formatter: (item, i) => `${i + 1}. ${item.username}`,
});

const page = pager.getPage(0);
await bot.sendMessage(channelId, page.content);
// page.current, page.total, page.hasNext, page.hasPrev
```

---

### TypeScript Kullanımı

SDK tam TypeScript desteğiyle gelir; `.d.ts` dosyaları `dist/` altında bulunur.

```ts
import {
  BridgeBot,
  BotMessage,
  CommandContext,
  InteractionData,
  EmbedBuilder,
  ButtonBuilder,
  BotStore,
  PaginationHelper,
} from 'bridge-bot-sdk';

const bot = new BridgeBot({ token: process.env.BOT_TOKEN! });

bot.command('merhaba', {
  description: 'Selamlama',
  handler: async (ctx: CommandContext): Promise<void> => {
    await ctx.reply('👋 Merhaba!');
  },
});
```

---

### Hata Yönetimi

```ts
// Komut bazlı hata yakalama
bot.on('commandError', ({ command, error, ctx }) => {
  console.error(`/${command} hatası:`, error);
  // Yanıt reddi BridgeApiError'dır: error.status + error.code (ör. 'reply_limit').
  console.error(ctx.channelId, error);
});

// Rate limit izleme
bot.on('rateLimit', ({ path, retryAfter }) => {
  console.warn(`Rate limit: ${path} — ${retryAfter}s bekle`);
});

// Bağlantı kopması
bot.on('disconnect', reason => {
  console.warn('Bağlantı koptu:', reason);
  // SDK otomatik yeniden bağlanır (Socket.IO reconnect)
});
```

---

# Runtime status

## Shipping transport status

Bot transportu artık üç gerçek yüzeye sahiptir:

1. `Authorization: Bot brg_bot_…` ile `/api/v1/bots/me`, slash metadata ve context
   metadata registration. Token yalnız SHA-256 digest ile DB'de tutulur; yeni tokenlar
   32-byte CSPRNG opaque bearer secret olarak üretilir ve `active=true` zorunludur.
2. Socket.IO handshake aynı bot tokenını doğrular ve botu yalnız `bot:<botId>` özel
   odasına alır. Bot tüm private channel odalarına subscribe edilmez. Persist edilmiş
   `/command` mesajı yalnız o komutu gerçekten kaydetmiş installed bot(lar)a direct
   dispatch edilir; interaction'lar da aynı özel bot odasına gider.

3. `POST /api/v1/bots/interactions/:messageId/reply` — çağrılan komuta yanıt
   (Final21 Phase 14). Kanonik gönderim yolunun bot için anlamlı güvenceleri uygulanır:
   AutoMod aynı değerlendiriciyle, çağrı başına 5 yanıt sınırı, geçmiş önbelleğinin
   geçersiz kılınması. Pazaryerinden kurulan bot bu izni ancak yöneticinin açık onayıyla
   (`acceptedPermissions`) alır; izin kurulum satırında (`server_bots.grantedScopes`) saklanır.

### Deliberately unsupported product surfaces

Serbest kanal mesajı yazma, düzenleme/silme, reaction/history, member/role management,
moderation ve modal açma hâlâ bot principal için canonical authority sahibi değildir.
SDK bunları user endpointlerine gönderip 401/404 üretmez; doğrudan
`BridgeUnsupportedError` fırlatır.

Özellikle `sendMessage` için ikinci bir REST messaging implementation yazılmadı.
Doğru sonraki adım mevcut `sendChannelMessage()` business authority'sini
transport-independent bir principal modeline ayırmaktır; permission/slowmode/AutoMod/
notification/idempotency davranışını kopyalamak kabul edilmez.

