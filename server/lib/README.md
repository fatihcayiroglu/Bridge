# Bridge — server/lib/

Çekirdek altyapı modülleri. `routes/` veya `socket/` değil — bunlar saf utility.

**Oturum B — TypeScript migration tamamlandı** (22 dosya, ~3.600 satır)

## Modüller

| Dosya | Ne yapar |
|-------|----------|
| `logger.ts` | Pino logger singleton. LOG_LEVEL env'den okur. |
| `userUtils.ts` | `sanitizeUser()` — API yanıtlarında hassas alanları çıkarır. `SafeUser` tipi. |
| `modRules.ts` | Kural tabanlı moderasyon (AI yok). `rulesMod()`, `rulesSummary()`. |
| `permCache.ts` | İzin önbellekleme (30s TTL, Map). `getCachedPerms()`, `invalidatePerms()`. |
| `permissions.ts` | Discord-style bitmask. Rol hiyerarşisi, kanal override, `PERMS` flags, `resolvePermissions()`. |
| `security.ts` | XSS sanitization, anti-spam, progressive rate limit, CSRF, `securityHeaders` middleware. |
| `httpSignature.ts` | HTTP Signature (cavage-draft) doğrulama. Federation HMAC. |
| `env.ts` | Sunucu başlamadan önce `.env` doğrulama. Eksik var → `process.exit(1)`. |
| `turnConfig.ts` | STUN/TURN ICE sunucu listesi. coturn HMAC credential üretimi. |
| `sfuRegistry.ts` | Redis-backed SFU oda kaydı. Cluster modda hangi node hangi ses odasını yönetiyor. |
| `aiProvider.ts` | AI sağlayıcı soyutlaması. Groq → Gemini → OpenRouter → Ollama → rules fallback zinciri. |
| `mailer.ts` | Nodemailer e-posta. Doğrulama, şifre sıfırlama, şüpheli giriş uyarısı. Dev: konsola basar. |
| `redisAdapter.ts` | Socket.io adapter + LRU cache + session/rate limit. Redis yoksa in-memory fallback. |
| `notifications.ts` | Mention detection, realtime socket notif, push (VAPID+FCM), unread count, Express router. |
| `pushSender.ts` | Web Push (VAPID), FCM HTTP v1 (OAuth2), badge sayacı. |
| `svgSanitizer.ts` | SVG XSS temizleme. Tehlikeli element/attribute'ları strip eder. |
| `cdnStorage.ts` | R2 / B2 / local depolama soyutlaması. `uploadToCDN()`, `deleteFromCDN()`. |
| `linkPreview.ts` | Link önizleme. In-process LRU + PostgreSQL TTL cache. SSRF koruması. |
| `contentScanner.ts` | CSAM hash, VirusTotal, SVG XSS, MIME anomali. Karantina + admin API. |
| `captcha.ts` | hCaptcha / Turnstile. Progressive CAPTCHA, giriş kilidi, bot skoru, replay koruması. |
| `e2e.ts` | E2EE public key API + X3DH prekey bundle. Signal Protocol tabanlı. |
| `swagger.ts` | OpenAPI spec + Swagger UI. Oturum C tamamlandı (Sprint 79): JSON tip güvenliği, `$ref` resolver, `operationId` otomasyonu, `validateSpec()`. |

## Kullanım

```ts
// İzin kontrolü
import { resolvePermissions, hasPermission, PERMS } from './lib/permissions';
const perms = await resolvePermissions(userId, serverId, channelId);
if (!hasPermission(perms, PERMS.SEND_MESSAGES)) return res.status(403)...

// Cache
import { cache } from './lib/redisAdapter';
await cache.set('key', data, 60);
const val = await cache.get('key');

// Mention notification
import { processNotifications } from './lib/notifications';
await processNotifications(msg, io, socketUsers);

// Anti-spam
import { checkSpam } from './lib/security';
const result = checkSpam(userId, content);
if (result.blocked) return; // spam!

// AI
import { callAI, AI_ENABLED, PROVIDER } from './lib/aiProvider';
if (AI_ENABLED) {
  const summary = await callAI('Sen bir özetleyicisin.', messages);
}

// CDN yükleme
import { uploadToCDN } from './lib/cdnStorage';
const { url } = await uploadToCDN('/tmp/file.jpg', `avatars/${userId}.jpg`);

// Push bildirimi
import { sendPushToUser } from './lib/pushSender';
await sendPushToUser(userId, { title: 'Yeni mesaj', body: preview });

// CAPTCHA middleware
import { loginLockMiddleware, progressiveCaptchaMiddleware } from './lib/captcha';
router.post('/login', loginLockMiddleware, progressiveCaptchaMiddleware, loginHandler);

// E2EE router
import { router as e2eRouter } from './lib/e2e';
app.use('/api/e2e', e2eRouter);
```

## env.ts — sunucu başlangıcında çalıştır

```ts
// server/index.ts — EN BAŞA ekle (diğer importlardan önce)
import './lib/env';
```

## Redis Kurulumu (opsiyonel)

```bash
docker run -d -p 6379:6379 redis:alpine
# .env
REDIS_URL=redis://localhost:6379
```

Redis olmadan da çalışır — sadece multi-instance scaling desteklenmez.

## Migration Notları

### JS → TS değişiklikleri
- Tüm `module.exports` → named `export` / `export default`
- Tüm `require()` → `import`
- `@types/express`, `@types/node` gerektir
- `redisAdapter.ts`: `getClient()` kaldırıldı → `redisClient()` fonksiyonu ile erişilir
- `captcha.ts`: `redisAdapter`'dan `redisClient()` kullanıyor (v45'te `getClient()` vardı, düzeltildi)
- `modRules.ts`: `\\1` regex escape hatası düzeltildi
- `security.ts` / `redisAdapter.ts`: memory guard (`MAX_*_ENTRIES`) eklendi (JS versiyonunda yoktu)
- `pushSender.ts`: FCM legacy API → FCM HTTP v1 (OAuth2) ile güncellendi

### Breaking changes yok
Tüm export isimleri JS versiyonuyla birebir aynı.
