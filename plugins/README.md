# Bridge Plugin Sistemi

Bridge'e özel işlevsellik eklemek için plugin API'si.

## Klasör Yapısı

```
plugins/
├── welcome-bot/
│   ├── plugin.json   ← Metadata ve config
│   └── index.ts      ← Plugin kodu
├── word-filter/
│   ├── plugin.json
│   └── index.ts
├── auto-role/
│   ├── plugin.json
│   └── index.ts
└── benim-pluginim/
    ├── plugin.json
    └── index.ts
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
  "permissions": ["messages:read", "messages:send"],
  "config": {
    "anahtar": "değer"
  }
}
```

`disabled: true` yapılırsa plugin yüklenmez.

## Plugin API

Plugin'in canonical kaynağı `index.ts` dosyasıdır ve bir `setup(ctx)` fonksiyonu export eder. `npm run build:plugins` production için aynı kaynaktan deterministik `index.js` artefact'ı üretir; generated JS elle düzenlenmemelidir:

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

Server event abonelikleri deny-by-default capability kontrolünden geçer. Şu anda plugin API'sinde açık olan server event'leri:

| Event | Gerekli izin | Payload |
|-------|--------------|---------|
| `member:joined` | `members:read` | `{ userId, serverId, displayName, username }` |
| `message:created` | `messages:read` | `{ messageId, channelId, serverId, userId, content, displayName }` |

Plugin kendi `plugin:<plugin-id>:...` namespace'inde özel hook kullanabilir. Manifestte capability'si olmayan server event abonelikleri kaydedilmez.

### Plugin Aksiyonları (emit edilebilir — sunucu işler)

Aksiyonlar yalnız `setup()` başarıyla commit olduktan sonra çalışır ve loader manifestteki izinleri origin-bound bir envelope ile server'a taşır. Plugin'in payload içine kendi permission bilgisini eklemesi yetki vermez.

| Aksiyon | Gerekli izin |
|---------|--------------|
| `plugin:sendMessage` | `messages:send` |
| `plugin:deleteMessage` | `messages:delete` |
| `plugin:grantRole` | `roles:assign` |


Bu event'ler `server/plugins/actions.ts` tarafından işlenir:

| Event | Davranış |
|-------|----------|
| `plugin:sendMessage` | Sistem/bot mesajı oluşturur, `message:new` broadcast |
| `plugin:deleteMessage` | Mesajı siler, `message:deleted` broadcast |
| `plugin:grantRole` | Üyeye rol atar (`Members.setRoles`) |

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

// Rol ata (sunucu tarafından işlenir)
ctx.hooks.emit('plugin:grantRole', {
  userId:   '...',
  serverId: '...',
  roleId:   '...',
});
```

---

## ctx.db — Veritabanı (Read-Only)

```js
// Kanal ara
const channels = await ctx.db.channels.find({ serverId });

// Tek kayıt bul (manifest: channels:read)
const channel = await ctx.db.channels.findOne({ _id: channelId });

// Sayım (manifest: messages:read)
const count = await ctx.db.messages.count({ channelId });
```

DB erişimi de capability-bound'dur; koleksiyon sadece manifest gerekli izni taşıyorsa okunabilir:

- `messages` → `messages:read`
- `channels` → `channels:read`
- `members` → `members:read`
- `servers`, `roles` → `server:info`

`users` koleksiyonu plugin read API'sine açık değildir. Yetkisiz/unknown koleksiyon erişimi boş read-only görünüm döndürür.

> **Not:** Plugin'ler veritabanına yazamaz — yalnızca izin verilmiş read-only koleksiyonları okuyabilir.
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

Desteklenen metodlar: `GET`, `POST`, `PUT`, `PATCH`, `DELETE`. Loader bütün plugin HTTP route'larına uygulamanın canonical authentication middleware'ini otomatik ekler; plugin route'u anonim olarak mount edilemez.

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

- Bundled plugin'ler manifestte ihtiyaç duydukları capability'leri açıkça beyan eder.
- Bilinmeyen/banned izinler manifest validation'da reddedilir.
- DB read, server hook subscription ve privileged action emit işlemleri deny-by-default capability kontrolündedir.
- Plugin HTTP route'ları canonical auth middleware arkasında mount edilir.
- `setup()` transactional'dır: setup throw/timeout ederse staged route/hook'lar commit edilmez ve context inert hale gelir.
- `setup()` commit edilmeden event/action emit edilemez.
- Canonical plugin kaynağı `index.ts`; production `index.js` build sırasında aynı kaynaktan üretilir.
- Bundled olmayan local plugin'ler varsayılan olarak yüklenmez. Yalnız bilinçli, güvenilmeyen kod çalıştırma riski kabul edilen local development senaryosunda `ALLOW_UNSAFE_LOCAL_PLUGINS=true` ile açılabilir.
- `disabled: true` ile plugin devre dışı bırakılabilir.

> `ALLOW_UNSAFE_LOCAL_PLUGINS=true` gerçek bir security boundary değildir. Node `vm` sandbox'ı hostile third-party code için tam izolasyon sağlamaz; bu seçenek yalnız güvenilir local development plugin'leri içindir.

## İpuçları

- Plugin config'ini `ctx.meta.config` üzerinden oku
- `ctx.logger.log/warn/error` kullan — prefix otomatik eklenir: `[plugin:benim-pluginim]`
- `setup()` async olabilir — await kullanabilirsin
