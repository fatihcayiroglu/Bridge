# Sprint 29 Değişiklikleri

## 🔴 KIRMIZI — Native fetch (Node 22+) güvenliği

**Durum:** node-fetch bağımlılığı zaten yoktu. Asıl sorun: 26 `fetch()` çağrısı `AbortSignal` olmadan çalışıyordu → hung request riski.

**Yapılanlar:**
- `lib/fetch.ts` — `fetchT()` yardımcı fonksiyonu oluşturuldu (User-Agent + timeout wrapper)
- Tüm `fetch()` çağrılarına `AbortSignal.timeout()` eklendi:
  - `lib/pushSender.ts` — OAuth2 token + FCM gönderim (10s)
  - `lib/contentScanner.ts` — VirusTotal hash/upload/analysis (15s / 60s / 15s)
  - `lib/e2e.ts` — E2E key API (10s)
  - `routes/federation/helpers.ts` — ActivityPub inbox resolve + delivery (8s / 10s)
  - `routes/federation/peers.ts` — eski `AbortController+setTimeout` → `AbortSignal.timeout(8s)`
  - `routes/media.ts` — Tenor GIF + LibreTranslate (8s / 15s)
  - `routes/voicemsg.ts` — Whisper API (30s)
  - `routes/ai/streaming.ts` — SSE stream'ler (60s Groq, 120s Ollama, 30s Gemini, 60s OpenRouter)
  - `routes/ai/translate.ts` — LibreTranslate (10s)

## 🟠 TURUNCU — federation.ts → federation/ klasörü

**Durum:** Zaten tamamlanmış. `routes/federation/` klasörü mevcut, `setupRoutes.ts`'de doğru bağlı.

## 🟡 SARI — Swagger Annotations

**Yapılanlar:**
- `routes/webauthn.ts` — 7 endpoint tam `@openapi` annotation (register/begin, register/complete, login/begin, login/complete, GET/PATCH/DELETE /credentials)
- `routes/ai/index.ts` — 9 endpoint (status, suggest-reply, discover-match, ask/stream, clyde/stream, summarize, translate, moderate, auto-moderate)
- `routes/admin/core.ts` — 15 endpoint (stats, users, servers, logs, broadcast, make-first-admin, quarantine, ip-bans, federation whitelist/blacklist, sfu/stats)

## 🟡 SARI — Rate Limit Granülerliği

**Yapılanlar:**
- Yeni `'per-user-ip'` modu eklendi: `rl:{prefix}:u:{uid}` + `rl:{prefix}:uip:{uid}:{ip}` çift anahtar
- VPN IP dönüşüm saldırılarını ve çok hesaplı kötüye kullanımı engeller
- `moderation` limiti `combined` → `per-user-ip` olarak güncellendi
- `_uip()` yardımcı fonksiyonu export'a eklendi

## 🟡 SARI — db/loader.ts Bug Fix

**Yapılanlar:**
- `export default db` satırı üç kez yazılmıştı → tek satıra indirildi (TypeScript derleme hatası)

## 🟡 SARI — db/sqlite/ Silme Durumu

**Durum:** `bridge10.test.js` ve `auth.test.js` doğrudan `db/index`'i require ediyor.
- `db/index.ts` — deprecation uyarısı eklendi
- `db/sqlite/LEGACY.md` — sprint 30+ silme planı güncellendi
- Tam silme: testler pg-mock'a geçtiğinde yapılacak

## 🟢 Devam Eden (bu sprintte dokunulmadı)

- A11Y (ARIA labels + klavye navigasyonu)
- OpenTelemetry + Sentry
- esbuild code splitting → chunk-heavy.js lazy loading
- CDN + WebP (sharp entegrasyonu)
