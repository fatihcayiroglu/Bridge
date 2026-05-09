# bridge-discord-shim

Discord.js v14 uyumlu uyumluluk katmanı. Mevcut Discord botlarını Bridge'de sıfır ya da minimum değişiklikle çalıştırır.

---

## Kurulum

```bash
npm install bridge-discord-shim
```

## Geçiş — 3 Adım

### Adım 1: Import'u değiştir

```diff
- const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
+ const { Client, GatewayIntentBits, EmbedBuilder } = require('bridge-discord-shim');
```

### Adım 2: Token env değişkenini güncelle

```diff
- DISCORD_TOKEN=your_discord_token
+ BRIDGE_TOKEN=brg_bot_xxxxxxxxxxxx
+ BRIDGE_URL=https://your-bridge-server.com
```

### Adım 3: Çalıştır

```bash
node bot.js
```

---

## Desteklenen Discord.js API Yüzeyi

### Client
| Metot / Özellik | Durum | Not |
|---|---|---|
| `new Client({ intents })` | ✅ | intents görmezden gelinir |
| `client.login(token)` | ✅ | Bridge token kabul eder |
| `client.destroy()` | ✅ | |
| `client.user` | ✅ | |
| `client.guilds.cache` | ✅ stub | |
| `client.commands` | ✅ | Collection döndürür |
| `client.on(Events.X, ...)` | ✅ | |

### Events
| Discord Event | Bridge Karşılığı |
|---|---|
| `Events.ClientReady` | `bot.on('ready')` |
| `Events.MessageCreate` | `bot.on('message')` |
| `Events.MessageUpdate` | `bot.on('messageEdit')` |
| `Events.MessageDelete` | `bot.on('messageDelete')` |
| `Events.InteractionCreate` | `bot.on('interaction')` |
| `Events.GuildMemberAdd` | `bot.on('memberJoin')` |
| `Events.GuildMemberRemove` | `bot.on('memberLeave')` |
| `Events.MessageReactionAdd` | `bot.on('reaction')` |

### Message
| Özellik / Metot | Durum |
|---|---|
| `.id`, `.content`, `.channelId`, `.guildId` | ✅ |
| `.author.id`, `.author.username`, `.author.bot` | ✅ |
| `.channel.send()` | ✅ |
| `.reply()` | ✅ |
| `.delete()` | ✅ |
| `.react()` | ✅ |
| `.edit()` | ✅ |
| `.mentions.users` | ✅ |

### Interaction (Slash Komut)
| Özellik / Metot | Durum |
|---|---|
| `.commandName` | ✅ |
| `.user`, `.member`, `.guildId`, `.channelId` | ✅ |
| `.options.getString()` | ✅ |
| `.options.getInteger()` | ✅ |
| `.options.getUser()` | ✅ |
| `.options.getBoolean()` | ✅ |
| `.reply()` | ✅ |
| `.deferReply()` | ✅ stub |
| `.editReply()` | ✅ |
| `.followUp()` | ✅ |
| `.isChatInputCommand()` | ✅ |
| `.isButton()` | ✅ |

### EmbedBuilder
| Metot | Durum | Not |
|---|---|---|
| `.setTitle()` | ✅ | |
| `.setDescription()` | ✅ | |
| `.setColor()` | ✅ stub | Renk Bridge markdown'da yok |
| `.addFields()` | ✅ | inline alanlar desteklenir |
| `.setFooter()` | ✅ | string veya `{ text }` |
| `.setThumbnail()` | ✅ stub | |
| `.setImage()` | ✅ stub | |
| `.setTimestamp()` | ✅ | Footer'a eklenir |
| `.setAuthor()` | ✅ | |

### ActionRowBuilder / ButtonBuilder
| Metot | Durum |
|---|---|
| `new ActionRowBuilder().addComponents(...)` | ✅ |
| `new ButtonBuilder().setCustomId().setLabel().setStyle()` | ✅ |
| `ButtonStyle.Primary / Secondary / Success / Danger` | ✅ |

### REST (Slash Komut Kaydı)
Discord botları genellikle `REST.put(Routes.applicationCommands(...), { body })` ile slash komutlarını kaydeder. Bridge'de bu işlem otomatiktir; `REST.put` no-op olarak çalışır ve hata vermez.

---

## Tam Örnek — Discord.js botu değiştirilmeden

```js
// bot.js — Discord.js v14 koduyla aynı, sadece import satırı değişti
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
} = require('bridge-discord-shim'); // ← tek değişiklik

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.commands = new Map();

// Slash komut tanımla
const pingCommand = {
  data: new SlashCommandBuilder().setName('ping').setDescription('Pong!'),
  async execute(interaction) {
    await interaction.reply('🏓 Pong!');
  },
};

client.commands.set('ping', pingCommand);

client.once(Events.ClientReady, (c) => {
  console.log(`✅ ${c.user.tag} Bridge'e bağlandı!`);
});

client.on(Events.MessageCreate, (message) => {
  if (message.author.bot) return;
  if (message.content === '!merhaba') {
    message.reply('👋 Merhaba!');
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    await interaction.reply({ content: '❌ Bir hata oluştu.', ephemeral: true });
  }
});

// Bridge'de slash komutlar otomatik kaydedilir; REST.put no-op'tur
const rest = new REST().setToken(process.env.BRIDGE_TOKEN);
rest.put(Routes.applicationCommands(client.application.id), {
  body: [...client.commands.values()].map(c => c.data.toJSON()),
}).then(() => console.log('Komutlar kaydedildi.'));

client.login(process.env.BRIDGE_TOKEN);
```

---

## Sınırlamalar

Aşağıdaki Discord.js özellikleri Bridge'de karşılıksızdır ve stub olarak çalışır (hata vermez, işlem yapmaz):

- **Embed renkleri** — Bridge markdown renk desteklemiyor
- **Attachment / dosya gönderme** — Bridge upload API'si ayrı çalışır
- **Guild/sunucu yönetimi** (kanal oluşturma, rol rengi vs.)
- **Webhook oluşturma** — Bridge webhook sistemi ayrı API kullanır
- **Presence / Activity** — "X oynuyor" tarzı durum göstergeleri
- **Voice bağlantısı** — Discord.js voice client (Bridge'de WebRTC kullanılır)
- **Autocomplete** interactions

---

## Geliştirici Notu

Bu shim "sıfır fork" ilkesiyle tasarlanmıştır: Bridge Bot SDK'ya dokunmaz, üstüne bir uyumluluk katmanı ekler. Bridge Bot SDK'nın doğal API'sine erişmek için:

```js
const shim = require('bridge-discord-shim');
const client = new shim.Client({ intents: [] });
await client.login(token);

// Bridge SDK'ya doğrudan erişim
const bridgeBot = client._bot; // BridgeBot instance
```
