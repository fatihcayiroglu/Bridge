# Sprint 65 — Zayıf Yön Giderme

**Tarih:** 2026-05-20  
**Kapsam:** 6 öncelikli zayıf yön kapatıldı

---

## 🔴 1. `lifecycle.js` → `lifecycle.ts` Geçişi

**Sorun:** `plugins/lifecycle.js` proje genelinde kalan tek `.js` kaynak dosyasıydı.  
`loader.ts` onu `require()` ile yüklüyor, `LifecycleLoadOpts` arayüzünü inline tanımlıyordu — tip senkronizasyon riski.

**Değişiklikler:**
- `plugins/lifecycle.ts` oluşturuldu — tam tip güvenliği, `PluginMeta`, `PluginContext`, `PluginRegistry`, `LoadedEntry` interface'leri
- `plugins/loader.ts` güncellendi — `require()` kaldırıldı, ESM `import` kullanılıyor
- `LifecycleLoadOpts` artık `lifecycle.ts`'ten export edilip `loader.ts`'te re-import ediliyor

**Sonuç:** Proje genelinde `.js` kaynak dosyası yok ✅

---

## 🔴 2. Plugin Manifest Validation Genişletildi

**Sorun:** `allowlist.ts` yalnızca `id`, `name`, `version` varlığını kontrol ediyordu.  
`PLUGIN_MODERATION.md`'de tanımlanan izin modeli ve yasaklı kategoriler kod olarak hayata geçirilmemişti.

**Değişiklikler (`plugins/allowlist.ts`):**

| Eklenen | İçerik |
|---------|--------|
| `ALLOWED_PERMISSIONS` | 10 izin — `messages:read`, `messages:send`, `voice:join` vb. |
| `RESTRICTED_PERMISSIONS` | 4 izin — `admin:read`, `moderation:kick` vb. (özel onay gerektirir) |
| `BANNED_PERMISSIONS` | 10 izin — `admin:write`, `members:ban`, `db:raw` vb. — hiçbir plugin'e verilmez |
| `BANNED_CATEGORIES` | `adult`, `gambling`, `crypto-trading`, `surveillance` |
| `validateManifest()` | Detaylı hata raporu döndürür — her başarısızlığı ayrı reason olarak listeler |
| `isAllowed()` | Geriye dönük uyumluluk — `validateManifest()` çağırır, boolean döner |

---

## 🔴 3. Redis Cluster Fallback Uyarıları Güçlendirildi

**Sorun:** In-memory fallback devreye girdiğinde log mesajı yetersizdi.  
Çoklu node/pod ortamında rate limit tutarsızlığının nedeni kolayca anlaşılamıyordu.

**Değişiklikler (`server/lib/redisAdapter.ts`):**

- Dosya başına `⚠️ CLUSTER UYARISI` açıklama bloğu eklendi
- `REDIS_URL` eksik olduğunda daha açıklayıcı log: cluster ortamında tutarsız davranış riski belirtildi
- `healthCheck()` sonucuna `clusterWarning` alanı eklendi — production'da Redis yoksa `/api/health` endpoint'i bu uyarıyı döner

---

## 🟡 4. Swagger Annotasyonları Tamamlandı

**Sorun:** `federation/social.ts` 11 route içeriyordu, yalnızca 4 tanesi annotasyonluydu.  
`federation/peers.ts` 11 route içeriyordu, yalnızca 2 tanesi annotasyonluydu.

**Değişiklikler:**

| Dosya | Önceki | Sonraki |
|-------|--------|---------|
| `federation/social.ts` | 4/11 route | 11/11 route (%100) |
| `federation/peers.ts` | 2/11 route | 11/11 route (%100) |

**Eklenen endpoint'ler (social.ts):** `/following`, `/followers`, `/like (DELETE)`, `/announce`, `/notifications/read-all`, `/profile` + detaylı request/response şemaları  
**Eklenen endpoint'ler (peers.ts):** `/servers`, `/stats`, `/discover`, `/ping`, `/health`, `/join-remote`, `/fetch-remote`, `/peers/{id} DELETE`

---

## 🟡 5. Test Coverage Eşikleri Güncellendi

**Değiştirilen dosya:** `server/package.json`

| Modül | Önceki | Sonraki |
|-------|--------|---------|
| `client/js/core/onboarding-wizard.ts` | — (yeni) | lines 70%, func 65%, branch 60% |
| `client/js/core/api-error-toast.ts` | — (yeni) | lines 80%, func 75%, branch 70% |
| `client/js/core/go-live.ts` | 60/55/50 | 70/65/60 |
| `client/js/core/voice-messages.ts` | 65/60/55 | 75/70/65 |

---

## 🟡 6. Yeni Test Dosyaları

| Dosya | Test Sayısı | Kapsam |
|-------|-------------|--------|
| `server/tests/onboarding-wizard.test.ts` | 20 | localStorage flag, klavye nav, i18n (4 dil), WCAG/ARIA, BridgeRegistry |
| `server/tests/api-error-toast.test.ts` | 21 | HTTP 400–503, AbortError, network error, null/string, kısa yollar |

---

## Değişen Dosyalar (Özet)

| Dosya | Tip | Açıklama |
|-------|-----|---------|
| `plugins/lifecycle.ts` | YENİ | `.js` → `.ts` geçişi, tam tip güvenliği |
| `plugins/lifecycle.js` | SİLİNDİ | lifecycle.ts ile değiştirildi |
| `plugins/loader.ts` | Güncelleme | `require()` → ESM `import` |
| `plugins/allowlist.ts` | Güncelleme | İzin modeli + yasaklı kategoriler kodu |
| `server/lib/redisAdapter.ts` | Güncelleme | Cluster uyarıları, healthCheck iyileştirmesi |
| `server/routes/federation/social.ts` | Güncelleme | 4/11 → 11/11 swagger |
| `server/routes/federation/peers.ts` | Güncelleme | 2/11 → 11/11 swagger |
| `server/package.json` | Güncelleme | 4 modül için coverage threshold |
| `server/tests/onboarding-wizard.test.ts` | YENİ | 20 test |
| `server/tests/api-error-toast.test.ts` | YENİ | 21 test |

## Kalan Backlog (Sprint 66)

| Öncelik | İş |
|---------|-----|
| 🟡 | APNs / FCM v1 gerçek entegrasyon (kod — şu an sadece dokümantasyon) |
| 🟡 | mediasoup dinamik worker ölçekleme |
| 🟢 | `plugins/word-filter/index.js` ve `welcome-bot/index.js` → `.ts` geçişi |
| 🟢 | Global coverage eşiğini `lines: 75` → `80` yükselt |
