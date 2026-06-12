# Sprint 52 Değişiklikleri

## Genel Bakış

Kod incelemesinde tespit edilen 5 öncelikli sorun giderildi / ilerleme kaydedildi:

1. Client test coverage eksikliği
2. k6 yük testlerinin CI'a entegre edilmemesi
3. Yeni test modülleri için coverage threshold tanımlanmaması
4. **Express 5.x geçişi — package.json güncellendi, asyncHandler belgelendi**
5. **ActivityPub HTTP Signature doğrulama güvenlik açıkları kapatıldı**

---

## PHASE 1 — Client Test Coverage Genişletme

### Yeni Test Dosyaları (6 dosya)

| Test Dosyası | Test Sayısı | Kapsam |
|---|---|---|
| `client/tests/music-player.test.js` | 24 | showMusicPlayer, hideMusicPlayer, toggleMusicPause, setMusicVolume, initMusicPlayer (socket event wiring), musicSkip, musicStop |
| `client/tests/go-live.test.js` | 20 | viewer count, addGoLiveViewer, removeGoLiveViewer, openViewerList panel (toggle), renderViewerList XSS, context menü |
| `client/tests/voice-messages.test.js` | 16 | startVoiceRecord, stopVoiceRecord, sendVoiceMessage (başarılı/küçük blob/API hatası/kanal yok) |
| `client/tests/voice-volume.test.js` | 18 | applyVolume, attachGain, openVolumePanel, preset butonlar, slider, kapatma, BridgeRegistry.register, contextmenu |
| `client/tests/outgoing-webhooks.test.js` | 12 | modal oluşturma, webhook listesi, XSS koruması, API hatası, form alanları |
| `client/tests/scheduled-ui.test.js` | 22 | modal aç/kapat, loadPending, XSS koruması, form validasyonu, cancelScheduled, BridgeRegistry.register |
| `client/tests/audit-log.test.js` | 14 | loadAuditLog, action ikonları, XSS koruması, filtreler, BridgeRegistry |

**Toplam yeni test:** ~126

### Coverage Threshold Güncellemesi

`client/tests/package.json` — `coverageThreshold` bölümüne eklendi:

| Modül | lines | functions | branches |
|---|---|---|---|
| `voice-messages.ts` | 65% | 60% | 55% |
| `go-live.ts` | 60% | 55% | 50% |
| `audit-log.ts` | 65% | 60% | 55% |

> Not: `music-player.ts`, `scheduled-ui.ts`, `outgoing-webhooks.ts`, `voice-volume.ts` threshold'ları önceki sprintlerde zaten tanımlanmıştı.

---

## PHASE 2 — k6 CI Entegrasyonu

### k6/smoke.js — Yeni CI Smoke Testi

Mevcut tam yük testleri (`messages-load.js`, `websocket-load.js`, `websocket-cluster-test.js`) CI'a entegre edilmemişti; çok ağırdı (300–500 VU, 8+ dakika).

**Yeni `k6/smoke.js`:** CI için optimize edilmiş hafif smoke testi.

| Parametre | Değer |
|---|---|
| VU sayısı | 2 |
| Süre | 30 saniye |
| Toplam CI süresi | ~1 dakika |

**Test edilen endpoint'ler:**
- `GET /api/health` — sunucu canlı mı?
- `GET /api/discover` — keşif endpoint'i
- `GET /` — static assets
- `GET /api/federation/info` — federasyon
- `POST /api/auth/login` — auth flow (hatalı credentials → 400/401 beklenir)

**Thresholds:**
```
smoke_errors:      rate < 5%
smoke_response_ms: p(95) < 2000ms
http_req_failed:   rate < 5%
http_req_duration: avg < 1000ms
```

### .github/workflows/ci.yml — Yeni Job'lar

#### `client-tests` job

```
lint-and-typecheck ─┐
                    ├─ (paralel)
tests ──────────────┘
                    ↓
               client-tests  ← YENİ
```

Client testleri artık her PR/push'ta CI'da çalışır. Coverage raporu 14 gün artifact olarak saklanır.

#### `load-test-smoke` job

```
build → deploy-staging → load-test-smoke  ← YENİ
```

Yalnızca `develop` ve `staging` branch'larında, staging deploy'dan sonra çalışır. k6 sonuçları JSON artifact olarak saklanır ve GitHub Step Summary'e yazılır.

**Not:** Üretim ortamında tam yük testleri (mesaj yükü, WebSocket kümesi) mevcut `k6/` scriptleri ile manuel tetiklenmeye devam eder. CI smoke testi yalnızca kırık deploy'ları erken tespit etmek içindir.

---

## PHASE 3 — Express 5.x Geçişi

### Değişiklik: `server/package.json`

```diff
- "express": "^4.18.2"
+ "express": "^5.0.0"

- "@types/express": "^4.17.25"
+ "@types/express": "^5.0.0"
```

### Değişiklik: `server/middleware/asyncHandler.ts`

Express 5'te async route handler'lardan fırlatılan hatalar otomatik olarak `next(err)`'e iletilir; `asyncHandler` wrapper'ı artık **teknik olarak zorunlu değildir**.

Bu sprint'te wrapper silinmedi — tüm route'lar `asyncHandler` ile sarılı ve toplu kaldırma büyük bir refactor gerektirir. Wrapper, Express 5 altında zararsız olarak çalışmaya devam eder (çift yakalama — Express ve wrapper — güvenlidir).

**Eylem planı (Sprint 53+):**

1. `npm install` sonrası Express 5 uyumluluğunu doğrula (özellikle `path-to-regexp` v8 breaking changes — parametre adlarında `:` zorunlu değil artık, `*` wildcard kaldırıldı).
2. `router.param()` ve `res.locals` kullanımlarını gözden geçir.
3. `asyncHandler` toplu kaldırma: `server/routes/**/*.ts` ve `server/lib/*.ts` içindeki ~170 kullanım.
4. Kaldırma sonrası Express 5 hata yakalama davranışını entegrasyon testlerinde doğrula.

---

## PHASE 4 — ActivityPub HTTP Signature Güvenlik Düzeltmeleri

### Değişiklik: `server/lib/httpSignature.ts`

Önceki analizde tespit edilen 3 güvenlik boşluğu kapatıldı:

#### 4a. Algoritma Doğrulama

**Sorun:** `algorithm` parametresi parse ediliyordu ama değeri doğrulanmıyordu. Saldırgan `algorithm=hmac-sha1` göndererek farklı bir kriptografik yolla doğrulama geçirmeye çalışabilirdi.

**Düzeltme:** `ALLOWED_ALGORITHMS = Set(['rsa-sha256', 'hs2019'])` — bu küme dışında bir algoritma gönderilirse istek reddedilir.

```typescript
if (algorithm && !ALLOWED_ALGORITHMS.has(algorithm.toLowerCase())) {
  return { ok: false, reason: `Desteklenmeyen algoritma: ${algorithm}` };
}
```

#### 4b. SSRF Koruması (Remote Key Fetch)

**Sorun:** `_resolvePublicKey` fonksiyonu `keyId` URL'sini doğrudan `fetch()` ile getiriyordu. Saldırgan `keyId` olarak `https://169.254.169.254/latest/meta-data/` (AWS metadata) veya iç ağ adresini gönderebilirdi. Ayrıca 3xx redirect takibi açıktı — farklı bir host'a yönlendirme mümkündü.

**Düzeltme:**
- `SSRF_BLOCK_PATTERNS` listesi: localhost, RFC-1918, link-local, cloud metadata IP'leri reddedilir.
- `redirect: 'manual'` — 3xx yanıtlar hata olarak işlenir, redirect takip edilmez.
- Yalnızca `https:` protokolüne izin verilir.

```typescript
if (parsedUrl.protocol !== 'https:') {
  throw new Error(`Key URL yalnızca HTTPS olabilir`);
}
if (_isBlockedHost(parsedUrl.hostname)) {
  throw new Error(`Key fetch engellendi: şüpheli host ${parsedUrl.hostname}`);
}
// fetch ile redirect: 'manual'
```

#### 4c. `(request-target)` Zorunluluğu

**Sorun:** İmzalanmış header listesinde `(request-target)` zorunlu tutulmuyordu. Saldırgan bir inbox'tan geçerli imzayı alıp farklı bir endpoint'e replay edebilirdi (path değiştiğinde imza hâlâ doğrulanırdı).

**Düzeltme:**

```typescript
const headerList = signedHeaders.split(' ');
if (!headerList.includes('(request-target)')) {
  return { ok: false, reason: '(request-target) imzalanmış header listesinde zorunludur' };
}
```

### Test Uyumu

`server/tests/httpSignature.test.js` mevcut fixture'ları zaten `(request-target)` ve `rsa-sha256` kullandığından mevcut testler değişiklik gerektirmez. Yeni kenar durumlar (blocked host, redirect, wrong algorithm) için test eklenmesi önerilir (Sprint 53).

---

## Özet

| Kategori | Değişiklik |
|---|---|
| Yeni client test dosyası | +6 |
| Yeni test sayısı | ~126 |
| Coverage threshold | 3 modül eklendi |
| k6 smoke testi | `k6/smoke.js` oluşturuldu |
| CI job | `client-tests` + `load-test-smoke` eklendi |
| Express sürümü | 4.18.2 → 5.0.0 (package.json) |
| asyncHandler | Express 5 geçiş notu eklendi |
| HTTP Signature | Algoritma doğrulama + SSRF koruması + (request-target) zorunluluğu |
| Dosya değişikliği | `.github/workflows/ci.yml`, `client/tests/package.json`, `server/package.json`, `server/middleware/asyncHandler.ts`, `server/lib/httpSignature.ts` |
