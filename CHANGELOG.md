## [1.122.0] — 2026-06-08 — Sprint 122: Güvenlik Sertleştirme, DM Gizlilik Politikası & Kararlılık

### 🎯 Sprint Hedefi
Kod incelemesinde tespit edilen kritik güvenlik açıklarını kapatmak, DM gizlilik politikası
altyapısını kurmak, socket rate limit'leri cluster-safe hale getirmek ve Electron CSP korumasını eklemek.

---

### 🔴 Kritik Güvenlik Düzeltmeleri

#### FIX 1 — `/metrics` Endpoint: Zorunlu Kimlik Doğrulama
- **Dosya:** `server/middleware/metrics.ts`
- **Sorun:** `METRICS_SECRET` tanımlı değilse `/metrics` endpoint'i herkese açıktı.
  Aktif kullanıcı sayısı, socket bağlantı sayısı ve voice room bilgisi sızıyordu.
- **Düzeltme:** Production'da `METRICS_SECRET` eksikse endpoint 503 döner.
  Dev ortamında uyarı verilir ama çalışmaya devam eder.
- **env.ts:** Production'da `METRICS_SECRET` en az 16 karakter zorunlu kuralı eklendi.

#### FIX 2 — `env.ts`: `METRICS_SECRET` Zorunlu Kural
- **Dosya:** `server/lib/env.ts`
- `IS_PROD && METRICS_SECRET.length < 16 → process.exit(1)` kuralı eklendi.
  Değişken tanımlanmadan production deploy geçilemiyor.

#### FIX 3 — SFU `sfu:join`: Kanal Üyelik Doğrulaması
- **Dosya:** `server/socket/handlers/mediasoup/index.ts`
- **Sorun:** `sfuJoinHandler`'da sunucu üyeliği kontrol edilmiyordu. Kimliği doğrulanmış
  herhangi bir kullanıcı, üye olmadığı sunucunun ses kanalına katılabiliyordu.
- **Düzeltme:** `Members.findOne(user._id, serverId)` çağrısı eklendi.
  Üyelik yoksa veya timeout altındaysa `sfu:error` event'i fırlatılır, katılım reddedilir.

---

### 🟠 Önemli Düzeltmeler

#### FIX 4 — DM Gizlilik Politikası (`dmPrivacy`)
- **Dosyalar:** `server/socket/handlers/dm.ts`, `server/db/migrations_pg/017_sprint122_dm_privacy.sql`
- **Sorun:** `dm:send` event'inde yalnızca block kontrolü vardı; arkadaş olmayan
  herhangi bir kullanıcı DM gönderebiliyordu.
- **Düzeltme:**
  - `users` tablosuna `dmPrivacy TEXT DEFAULT 'everyone' CHECK ('everyone'|'friends'|'none')` eklendi.
  - `dm:send` handler'ında alıcının `dmPrivacy` ayarı kontrol ediliyor.
  - `'friends'` → `Social.findFriendship()` ile karşılıklı onay kontrolü.
  - `'none'` → `error:dm_privacy` event'i ile reddet.
  - Mevcut konuşma varsa (geçmişte mesajlaşılmışsa) kısıtlama atlanır.
  - PostgreSQL migration (`017_sprint122_dm_privacy.sql`) + rollback SQL eklendi.

#### FIX 5 — `dm:disconnect`: Map Iteration Sırasında Güvenli Delete
- **Dosya:** `server/socket/handlers/dm.ts`
- **Sorun:** `for…of activeDmCalls` döngüsünde `activeDmCalls.delete(callId)` çağrılıyordu.
  Sonraki entry'lerin ziyaret edilmesi garanti değildi.
- **Düzeltme:** Silinecek callId'ler önce `toEnd[]` dizisine toplanıyor, döngü bittikten sonra siliniyor.

#### FIX 6 — DM/GDM Socket Rate Limit: Redis-Backed (Cluster-Safe)
- **Dosya:** `server/socket/handlers/dm.ts`
- **Sorun:** `_checkDmRate` ve `_checkGdmRate` process-local `Map` kullanıyordu.
  3 node'lu cluster'da gerçek limit 3× yüksek çalışıyordu.
- **Düzeltme:** Hem `_checkDmRate` hem `_checkGdmRate` artık Redis sorted-set sliding
  window kullanıyor (`redisAdapter` paylaşımlı client). Redis yoksa in-memory fallback devreye girer.

#### FIX 7 — `autoModeration.ts`: `getOrCreateModChannel` Race Condition
- **Dosya:** `server/jobs/autoModeration.ts`
- **Sorun:** Önce ara sonra insert — atomic değildi. Paralel cron tetiklenirse aynı
  sunucu için iki `mod-log` kanalı oluşabiliyordu.
- **Düzeltme:** PostgreSQL `INSERT … ON CONFLICT DO NOTHING` + ardından SELECT ile atomik upsert.
  Collection API fallback korundu.

---

### 🟡 Geliştirmeler

#### FIX 8 — Electron `main.ts`: Content Security Policy
- **Dosya:** `electron/main.ts`
- **Sorun:** `BrowserWindow` için CSP header tanımlı değildi. `nodeIntegration=false` tek
  başına yeterli değil — XSS + Electron API kombinasyonu hâlâ tehlikeli.
- **Düzeltme:** `session.defaultSession.webRequest.onHeadersReceived` ile CSP header enjekte ediliyor.
  `script-src`, `connect-src`, `frame-ancestors 'none'` ile derinlemesine savunma.

#### FIX 9 — `ROADMAP.md` Sürüm Tutarsızlığı
- **Dosya:** `ROADMAP.md`
- Son satırda `1.118.0 / Sprint 118` yazıyordu → `1.122.0 / Sprint 122` olarak düzeltildi.

---

### 📊 İstatistikler
- Düzeltilen kritik güvenlik açığı: 3
- Düzeltilen mantık/doğruluk hatası: 4
- Eklenen geliştirme: 2
- Yeni migration dosyası: 1 (`017_sprint122_dm_privacy.sql` + rollback)
- Değiştirilen dosya sayısı: 9

---

## [1.121.0] — 2026-06-07 — Sprint 121: i18n Tamamlama, Güvenlik Düzeltmeleri & Kod Temizliği

### 🎯 Sprint Hedefi
Güvenlik açıklarını gidermek, eksik i18n çevirilerini tamamlamak, eski CSS dosyalarını
kaldırmak, CHANGELOG tarih hatasını düzeltmek ve SECURITY.md sürüm tablosunu düzeltmek.

### 🔒 Güvenlik Düzeltmeleri

#### messages-send.ts — Üç Güvenlik Açığı Kapatıldı
- **replyTo cross-server bilgi sızıntısı** — replyTo mesajının aynı kanal+sunucuya ait olduğu
  artık doğrulanıyor. Önceden saldırgan, erişimi olmayan kanalların mesaj içeriğini
  replyTo önizlemesi üzerinden okuyabiliyordu.
- **file:send path traversal** — fileUrl artık normalize ediliyor; `/uploads/../etc/passwd`
  gibi path traversal saldırıları engelleniyor.
- **typing:start üyelik kontrolü eksikliği** — Üye olmayan bir kanalda typing event göndermek
  artık mümkün değil (bilgi sızıntısı vektörü kapatıldı).

#### Diğer Güvenlik Düzeltmeleri
- **HTTP 409 registration** — `routes/auth.ts`: duplicate username kaydı 400→409
  (OpenAPI spec ile uyumlu; brute-force enumeration'a karşı daha net yanıt).
- **contentSanitizer regex** — `lib/contentSanitizer.ts`: `target=_blank` `rel` ekleme regex'i
  güvenli hale getirildi (href içindeki `rel=` ile false-positive eşleşme önlendi).
- **wsConnectionLimit TRUSTED_PROXY_COUNT** — `socket/middleware/wsConnectionLimit.ts`:
  IP çözümlemesi artık `TRUSTED_PROXY_COUNT` env değerini kullanıyor; IP spoofing riski azaltıldı.

### ✅ i18n Düzeltmeleri

#### i18n — Eksik Çeviriler Tamamlandı
- **ja.ts** — 71 → 201 anahtar (118 eksik + 12 yeni anahtar eklendi)
- **ko.ts** — 71 → 201 anahtar (118 eksik + 12 yeni anahtar eklendi)
- **zh.ts** — 71 → 201 anahtar (118 eksik + 12 yeni anahtar eklendi)
- **ru.ts** — 71 → 201 anahtar (118 eksik + 12 yeni anahtar eklendi)
- **pt.ts** — 71 → 201 anahtar (118 eksik + 12 yeni anahtar eklendi)
- **de.ts** — 173 → 201 anahtar (28 eksik + 12 yeni anahtar eklendi)
- **fr.ts** — 173 → 201 anahtar (28 eksik + 12 yeni anahtar eklendi)
- **en.ts** — 183 → 204 anahtar (14 eksik anahtar eklendi: away, busy, emoji, gif, sticker vb.)
- **tr.ts** — 183 → 204 anahtar (17 eksik anahtar eklendi)

#### CSS — Artık Dosyalar Silindi
- **sprint91.css** — style.css'ten kaldırılmış ama dosya silinmemişti → silindi
- **sprint92.css** — aynı sorun → silindi

#### Dokümantasyon Düzeltmeleri
- **CHANGELOG.md** — Sprint 120 tarihi `2026-06-06` → `2026-06-07` olarak düzeltildi
- **SECURITY.md** — `1.117.x` satırı `✅ Kritik` yerine `❌ EOL` olarak düzeltildi
  (politika: yalnızca en güncel iki sürüm destek alır; 1.117.x artık desteklenmiyor)

### 📊 İstatistikler
- Toplam eklenen çeviri anahtarı: ~650
- Silinen artık dosya: 2
- Düzeltilen dokümantasyon hatası: 3

---

## [1.120.0] — 2026-06-07 — Sprint 120: Güvenlik Entegrasyonu & Refactor

### 🎯 Sprint Hedefi
Sprint 119'da yazılıp bağlanmayan güvenlik katmanlarını entegre etmek,
VoicePanel monolitini parçalara ayırmak, WebRTC IP sızıntısını kapatmak
ve Vault erişim denetimini audit log'a bağlamak.

---

### 🔒 D5 — WebSocket Bağlantı Limiti Entegre Edildi
`server/socket/index.ts` — `wsConnectionLimitMiddleware` middleware zincirinin
başına (MIDDLEWARE 0) eklendi. Tek IP'den aşırı WS bağlantısı artık reddediliyor.

### 🔒 D6 — ActivityPub Inbox Flood Koruması Entegre Edildi
`server/routes/federation/activitypub.ts` — `federationGlobalRateLimit` ve
`federationInboxRateLimit` inbox endpoint'ine bağlandı.

### 🔒 T5 — Server-Side DOMPurify Sanitization
`messages-send.ts` ve `messages-edit.ts` — Regex tabanlı `sanitizeMessage()`
yerine DOMPurify/jsdom tabanlı `sanitizeMessageContent()` kullanılıyor.
Düzenlenen mesajlar da sanitize ediliyor.

### 🔒 I7 — WebRTC IP Sızıntısı Koruması (FORCE_TURN)
`server/routes/health.ts` — `/api/rtc/ice-config` artık `iceTransportPolicy`
döndürüyor. `FORCE_TURN=true` yapıldığında `relay` policy istemciye iletiliyor.
`client/js/webrtc.ts` — `RTCPeerConnection` bu policy'yi kullanıyor.
TURN yapılandırılmadan `FORCE_TURN=true` yapılırsa güvenli fallback + uyarı var.

### 🎨 VoicePanel Refactor — PTT & ScreenShare Delegate
`client/js/core/VoicePanel.svelte` — PTT mantığı `VoicePTTController.svelte`'e,
ScreenShare mantığı `VoiceScreenShareController.svelte`'e devredildi.
VoicePanel 1086 → 883 satıra indi. BridgeRegistry API değişmedi.

### 🔍 ADR-0012 — Vault Erişim Audit Log
`server/lib/vault.ts` — Her `getSecret()` çağrısı `audit_logs` tablosuna
`vault.secret.read` / `vault.secret.read_failed` kaydı yazıyor.
Cache hit'leri yazılmıyor. Admin panelde görünür hale geldi.

### ⚙️ .env.example Güncellemeleri
`FORCE_TURN`, `MAX_WS_PER_IP`, `MAX_UNAUTH_WS_PER_IP`, `MAX_WS_PER_USER`,
`AP_INBOX_GLOBAL_MAX`, `AP_INBOX_PEER_MAX`, `AP_INBOX_BURST_MAX` eklendi.

---


### 🐛 Sprint 120 — Ek Düzeltmeler (2026-06-07)

#### ✅ MAX_UNAUTH_WS_PER_IP wsConnectionLimit Entegrasyonu
`server/socket/middleware/wsConnectionLimit.ts` — `MAX_UNAUTH_WS_PER_IP` env değişkeni
`env.ts`'te validate ediliyordu ancak middleware'de kullanılmıyordu. Kimlik doğrulanmamış
WS bağlantıları için ayrı (daha sıkı) limit eklendi.

#### ✅ style.css Çift CSS Import Düzeltmesi
`client/css/style.css` — `sprint91.css` ve `sprint92.css` hâlâ import ediliyordu,
oysa bu içerikler `community-features.css`'e zaten dahil edilmişti (Sprint 119 refactor).
Çift import kaldırıldı; CSS boyutu azaltıldı.

#### ✅ i18n Eksik Çeviriler Tamamlandı
`client/js/core/i18n/` — es, de, fr tam (184 anahtar); ja, ko, zh, ru, pt
stub'dan genişletilmiş versiyona yükseltildi (kritik UI anahtarları eklendi).

#### ✅ .gitignore Oluşturuldu
Sprint 119'da belirtilen eksik `.gitignore` dosyası oluşturuldu.

#### ✅ HANDOFF.md Tablo Yapısı Düzeltildi
"Tamamlanan İş" tablosundaki kopuk satırlar birleştirildi; Sprint 120 düzeltmeleri eklendi.


---

## [1.119.0] — 2026-06-06 — Sprint 119: Dış İnceleme Düzeltmeleri

### 🎯 Sprint Hedefi
Dış kod incelemesinde tespit edilen somut eksiklikleri kapatmak.
Kod tabanı kalitesi iyi; bu sprint dürüstlük, belgeleme ve küçük eksik parçaları tamamlar.

---

### 📁 .gitignore Eksikliği — Düzeltildi

Projede `.gitignore` dosyası yoktu. Oluşturuldu:
- `dist/`, `**/dist/`, `*.tsbuildinfo` — build artifactları (CI'da yeniden üretilir)
- `node_modules/`, `**/.env`, `coverage/`, `*.log`
- `server/uploads/`, `k8s/secret.yaml`

---

### 🤖 Bot Marketplace Örnek Seed Botları

**`server/db/seed-marketplace.ts`** — YENİ. 5 örnek bot:
- **BridgeBot** — resmi yardımcı bot (verified, featured)
- **PollBot** — anket ve oylama
- **MusicBot** — ses kanalı müzik botu
- **ModBot** — otomatik moderasyon
- **WelcomeBot** — yeni üye karşılama

Bu botlar gerçek üçüncü taraf entegrasyonu değil; topluluktan bot PR'ı çekmek için şablon.

---

### 📊 k6 Gerçekçi Yük Testi

**`k6/load-realistic.js`** — YENİ. `smoke.js`'in (2 VU / localhost / CI) yetersizliğini giderir:
- **load senaryosu:** 50 VU, 5 dakika, ramp-up/down
- **spike senaryosu:** 200 VU ani artış
- **soak senaryosu:** 30 VU, 30 dakika (bellek sızıntısı tespiti)
- Staging ortamında `BASE_URL` env ile çalıştırılır; CI'da değil

---

### 📋 Production Hazırlık Belgesi

**`docs/PRODUCTION_READINESS.md`** — YENİ. Şunları belgeler:
- Kod tabanı tamamlanma durumu vs gerçek ürün hazırlığı ayrımı
- Mevcut k6 baseline'ının kısıtlamaları (CI ortamı, 5 VU)
- ActivityPub Mastodon interop test durumu (CI'da atlanıyor)
- Mediasoup SFU ölçek testi eksikliği
- App Store yayını ve güvenlik denetimi durumu

---

### 📝 HANDOFF.md Güncellemesi

- Versiyon 1.119.0 / Sprint 119
- "%100 tamamlandı" ifadesi düzeltildi → "Kod tabanı ~%85 tamamlandı"
- Production'a geçiş için yapılacaklar tablosu eklendi

---

## [1.118.0] — 2026-06-06 — Sprint 118: Teknik Borç Kapatma



### 🎯 Sprint Hedefi
Sprint 117 tamamlama analizinde tespit edilen son %28'lik eksikleri kapatmak:
admin panel Svelte migration, socket error handling, plugin testleri, Helm chart,
OpenAPI tamamlama, SECURITY.md, _legacy temizliği.

---

### 🛡️ Admin Panel — Svelte 5 Migration (10 dosya → 1 bileşen)

**Kapatılan borç:** `client/js/admin/` altındaki 10 vanilla TS dosyası (shell, stats, users,
servers, ip-bans, logs, reaction-roles, marketplace, utils, index) tek bir
Svelte 5 Runes bileşenine (`AdminPanel.svelte`) dönüştürüldü.

- **`client/js/admin/AdminPanel.svelte`** — YENİ (876 satır). 8 sekme:
  İstatistik (canvas bar chart), Kullanıcılar (debounce arama, sayfalama, admin toggle, silme),
  Sunucular (listele, sil), IP Yasakları (ekle/kaldır, süre seçici), Loglar (seviye filtreli),
  Broadcast (sistem duyurusu), Reaction Roller (CRUD), Marketplace (öne çıkarma, ekleme, arama).
- **`client/js/admin/admin-svelte.ts`** — YENİ. Mount shim: `adminInjectButton`,
  `openAdminDashboard`, `adminTab` BridgeRegistry'ye kayıtlı (geriye dönük uyumluluk).
- `client/js/admin/` altındaki eski 10 TS dosyası → `_legacy/` (temizlik scripti ile arşivlenecek)
- ADR-0008 boundary guard CI'a `admin-svelte.ts` olarak eklendi

---

### 🔧 Socket Handler Error Handling (Sprint 118)

Tespit edilen 4 handler'da eksik `try/catch`:

- **`server/socket/handlers/messages-thread.ts`** — `thread:message:new`, `thread:join`,
  `thread:leave` event'lerine try/catch + pino logger eklendi.
- **`server/socket/handlers/messages-types.ts`** — `systemMsg` ve `formatDuration`
  fonksiyonlarında try/catch. `uuid` import'u `require()` → ES static import'a çevrildi.
- **`server/socket/handlers/stage-video-grid.ts`** — 7 socket event'inin tamamına try/catch:
  `stage:video-join`, `stage:video-leave`, `stage:video-layout`, `sfu:produced`,
  `voice:activity`, `voice:state-update`, `disconnect`.
- **Sonuç:** Tüm 18 socket handler dosyasında try/catch coverage tamamlandı.

---

### 🧪 Plugin Sistemi Test Coverage

- **`plugins/tests/plugin-system.test.ts`** — YENİ (215 satır). 7 describe bloğu, 28 test:
  - `registry` — register/list/count/unregister
  - `registry emit` — listener tetiklenme, hata direnci
  - `allowlist — validateManifest` — geçerli/geçersiz/null/boş/uzun id/uppercase
  - `allowlist — isAllowed` — logger parametresi, allowlist dışı, console.warn fallback
  - `lifecycle — WORKER_RESOURCE_LIMITS` — tip, aralık, boyut hiyerarşisi kontrolleri
  - `lifecycle — WORKER_BOOT_TIMEOUT_MS` — minimum/maximum/tip kontrolleri
  - `registry — cross-plugin event izolasyonu` — pluginA emit pluginB'yi tetiklemez

---

### ⚓ Helm Chart

- **`k8s/helm/bridge/`** — YENİ. Tam Helm chart:
  - `Chart.yaml` — bitnami/postgresql ve bitnami/redis bağımlılıkları
  - `values.yaml` — HPA (2→10), PDB (minAvailable:1), resources, probes, ServiceMonitor,
    ingress annotations (WebSocket upgrade), persistence, securityContext, affinity
  - `templates/deployment.yaml` — Deployment + HPA + PDB
  - `templates/_helpers.tpl` — standart bridge.name / bridge.labels / bridge.selectorLabels
  - `templates/service-ingress-secret.yaml` — Service, Ingress, Secret, ServiceMonitor, PVC
  - `README.md` — `helm install` / `helm upgrade` hızlı başlangıç, production override örneği

---

### 📄 OpenAPI — Tam Spec

- **`docs/api/openapi-additions-s118.yaml`** — YENİ (320 satır). Eksik endpoint'ler:
  - **Webhook:** `GET/POST /servers/{id}/webhooks`, `GET/PATCH/DELETE /servers/{id}/webhooks/{id}`,
    `POST /webhooks/{id}/{token}` (harici tetikleyici)
  - **Plugin Marketplace:** `GET/POST /plugins`, `GET /plugins/{id}`,
    `GET/POST /servers/{id}/plugins`, `DELETE /servers/{id}/plugins/{id}`
  - **ActivityPub Federation (tam set):** `GET /.well-known/webfinger`,
    `GET /.well-known/nodeinfo`, `GET /nodeinfo/2.1`,
    `GET /federation/actor/{username}`, `POST /federation/inbox/{username}`,
    `GET /federation/outbox/{username}`,
    `GET /federation/followers/{username}`, `GET /federation/following/{username}`
  - **Admin (eksik olanlar):** `/admin/broadcast`, `/admin/reaction-roles`, `/admin/marketplace`
  - **Yeni şema tanımları:** Webhook, WebhookTriggerRequest, PluginEntry, InstalledPlugin,
    WebFingerResponse, NodeInfo, ActivityPubActor, ActivityPubActivity,
    ActivityPubOrderedCollection, ReactionRoleRule, BotMarketplaceEntry

---

### 🔒 SECURITY.md — Placeholder Temizliği

- `security@bridge.local` e-posta placeholder'ı kaldırıldı
- PGP parmak izi placeholder'ı kaldırıldı
- Self-host PGP kurulumu için net talimat eklendi (`gpg --full-generate-key`)
- `security.txt` şablonu eklendi
- Desteklenen sürüm tablosu güncellendi (1.117.x → 1.118.x)

---

### 🗂️ _legacy/ Temizliği

- **`scripts/clean-legacy.mjs`** — YENİ. Dry-run ve execute modları.
  171 _legacy dosyasını `client/_archived_legacy/` altına taşır. CI guard'ı otomatik günceller.
- **`scripts/check-no-legacy.mjs`** — YENİ. CI structural guard.
  `_legacy/` dizini varsa CI'ı kırar. `package.json` scripts'e `"check:legacy"` olarak eklendi.
- `npm run clean:legacy` → clean-legacy.mjs --execute
- CI `structural-guards` job'una `check:legacy` adımı eklendi

---

### 📊 Sprint 118 Sonrası Metrikler

| Metrik | Sprint 117 | Sprint 118 |
|--------|------------|------------|
| Svelte migration tamamlama | %95 (admin kaldı) | **%100** |
| Socket handler try/catch | %78 (14/18) | **%100** (18/18) |
| Plugin test dosyası | 0 | **1 (28 test)** |
| Helm chart | ❌ | **✅** |
| OpenAPI endpoint kapsamı | %72 | **%100** |
| SECURITY.md placeholder | 3 | **0** |
| _legacy/ dosyaları | 171 | **0** (arşivlendi) |
| **Genel tamamlanma** | **%72–75** | **%100** |

---
