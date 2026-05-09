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
  description: 'Pong döndürür',
  handler: async ctx => ctx.reply('🏓 Pong!'),
});

bot.connect();
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
  description: 'Yardım menüsü',
  usage: '/yardim [konu]',
  handler: async ctx => {
    const konu = ctx.args[0];
    await ctx.reply(konu ? `${konu} hakkında: ...` : 'Komutlar: /ping /yardim');
  },
});
```

### Context Menu (Sağ-tık)

```js
bot.contextCommand('Kullanıcı Bilgisi', 'user', async ctx => {
  await ctx.reply(`ID: ${ctx.targetId}`);
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
| `message` | `{ _id, content, userId, channelId, serverId }` |
| `messageEdit` | `{ messageId, content, channelId }` |
| `messageDelete` | `{ messageId, channelId }` |
| `reaction` | `{ messageId, emoji, userId }` |
| `memberJoin` | `{ userId, serverId }` |
| `memberLeave` | `{ userId, serverId }` |
| `interaction` | `{ type, customId, userId, channelId }` |
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

```js
await bot.sendMessage(channelId, 'Merhaba!');
await bot.editMessage(channelId, messageId, 'Düzeltildi');
await bot.deleteMessage(channelId, messageId);
await bot.addReaction(channelId, messageId, '👍');
const messages = await bot.getMessages(channelId, 50);
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

```js
await bot.kick(serverId, userId, 'Spam');
await bot.ban(serverId, userId, 'Kural ihlali');
await bot.timeout(serverId, userId, 30, '30 dakika');

const members = await bot.getMembers(serverId);
await bot.addRole(serverId, userId, roleId);
await bot.removeRole(serverId, userId, roleId);
```

---

## Modal (Form)

```js
bot.showModal(userId, {
  customId: 'kayit',
  title:    '📝 Kayıt Formu',
  fields: [
    { id: 'isim',  label: 'İsminiz', required: true  },
    { id: 'sebep', label: 'Sebep',   required: false },
  ],
});

bot.onModalSubmit('kayit', async ctx => {
  await ctx.reply(`Teşekkürler ${ctx.fields.isim}!`);
});
```

---

## Hata Yönetimi

```js
bot.on('commandError', ({ command, error, ctx }) => {
  console.error(`/${command}:`, error.message);
  ctx.reply('❌ Bir hata oluştu.').catch(() => {});
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
