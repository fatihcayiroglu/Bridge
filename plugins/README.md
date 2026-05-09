# Bridge Plugin Sistemi

Bridge'e özel işlevsellik eklemek için plugin API'si.

## Klasör Yapısı

```
plugins/
├── welcome-bot/
│   ├── plugin.json   ← Metadata ve config
│   └── index.js      ← Plugin kodu
├── word-filter/
│   ├── plugin.json
│   └── index.js
└── benim-pluginim/
    ├── plugin.json
    └── index.js
```

## plugin.json Şeması

```json
{
  "id":          "benim-pluginim",
  "name":        "Benim Pluginim",
  "version":     "1.0.0",
  "description": "Plugin açıklaması",
  "author":      "Adın",
  "disabled":    false,
  "config": {
    "anahtar": "değer"
  }
}
```

`disabled: true` yapılırsa plugin yüklenmez.

## Plugin API

Plugin'in `index.js` dosyası bir `setup(ctx)` fonksiyonu export eder:

```js
async function setup(ctx) {
  // ctx.id      — plugin ID
  // ctx.meta    — plugin.json içeriği
  // ctx.hooks   — event bus
  // ctx.db      — read-only veritabanı erişimi
  // ctx.logger  — plugin'e özel logger
  // ctx.registerRoute(method, path, handler)
  // ctx.registerSocketEvent(event, handler)
}

module.exports = { setup };
```

---

## ctx.hooks — Event Bus

### Abone olmak

```js
ctx.hooks.on('member:joined', async ({ userId, serverId, displayName }) => {
  // ...
});

ctx.hooks.on('message:created', async ({ messageId, channelId, content }) => {
  // ...
});
```

### Sunucu Event'leri (dinlenebilir)

| Event | Payload |
|-------|---------|
| `member:joined` | `{ userId, serverId, displayName, username }` |
| `member:left` | `{ userId, serverId }` |
| `message:created` | `{ messageId, channelId, serverId, userId, content, displayName }` |
| `message:deleted` | `{ messageId, channelId, serverId }` |
| `server:updated` | `{ serverId, changes }` |
| `voice:joined` | `{ userId, channelId, serverId }` |
| `voice:left` | `{ userId, channelId, serverId }` |

### Plugin Aksiyonları (emit edilebilir)

```js
// Mesaj gönder
ctx.hooks.emit('plugin:sendMessage', {
  channelId: '...',
  serverId:  '...',
  content:   'Merhaba!',
  botName:   'Plugin Adı',
});

// Mesaj sil
ctx.hooks.emit('plugin:deleteMessage', {
  messageId: '...',
  channelId: '...',
  serverId:  '...',
});
```

---

## ctx.db — Veritabanı (Read-Only)

```js
// Kanal ara
const channels = await ctx.db.channels.find({ serverId });

// Tek kayıt bul
const user = await ctx.db.users.findOne({ _id: userId });

// Sayım
const count = await ctx.db.messages.count({ channelId });
```

Erişilebilir koleksiyonlar: `users`, `servers`, `channels`, `messages`, `members`, `roles`

> **Not:** Plugin'ler veritabanına yazamaz — yalnızca okuyabilir.
> Yazma işlemleri için `ctx.hooks.emit('plugin:...')` kullanın.

---

## ctx.registerRoute — HTTP Endpoint

```js
// GET /api/plugins/benim-pluginim/durum
ctx.registerRoute('GET', '/durum', (req, res) => {
  res.json({ status: 'active', uptime: process.uptime() });
});

// POST /api/plugins/benim-pluginim/aksiyon
ctx.registerRoute('POST', '/aksiyon', async (req, res) => {
  const { param } = req.body;
  // ...
  res.json({ ok: true });
});
```

Desteklenen metodlar: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`

---

## ctx.registerSocketEvent — Socket.IO

```js
ctx.registerSocketEvent('plugin:benim-event', async (data, socket, user) => {
  socket.emit('plugin:yanit', { message: 'Aldım!' });
});
```

---

## Yüklü Plugin Listesi

```
GET /api/plugins
Authorization: Bearer <token>
```

```json
[
  {
    "id":          "welcome-bot",
    "name":        "Welcome Bot",
    "version":     "1.0.0",
    "description": "Yeni üyeler sunucuya katılınca hoş geldiniz mesajı gönderir"
  }
]
```

---

## Güvenlik

- Plugin'ler `plugins/` klasörünün **dışına** dosya erişimi yapmamalı
- Veritabanına doğrudan yazma imkânı yok — sadece hook'lar üzerinden
- Her plugin ayrı bir try/catch ile korunuyor — bir plugin crash olsa diğerleri etkilenmez
- `disabled: true` ile plugin'i devre dışı bırakabilirsin

## İpuçları

- Plugin config'ini `ctx.meta.config` üzerinden oku
- `ctx.logger.log/warn/error` kullan — prefix otomatik eklenir: `[plugin:benim-pluginim]`
- `setup()` async olabilir — await kullanabilirsin
