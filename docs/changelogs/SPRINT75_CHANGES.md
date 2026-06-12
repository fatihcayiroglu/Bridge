# SPRINT75_CHANGES.md
_Tarih: 2026-05-22 | Temel: Sprint 74 (8.4/10)_

---

## Özet

Sprint 75, analiz raporunun belirlediği **6 teknik borç / güvenlik maddesini** kapatır.
Hiçbir public API değişmedi; tüm değişiklikler geriye uyumludur.

---

## 1. WebRTC Signaling Payload Validation (Kritik Güvenlik)

### Sorun
`dm:call:offer`, `dm:call:answer`, `dm:call:ice`, `gdm:call:offer`, `gdm:call:answer`,
`gdm:call:ice` event'leri `validateSocketPayload` çağırmıyordu.
Eksik `callId`, boş `targetUserId` veya `null` `targetSocketId` ile gelen event'ler
bloklanmadan iletiliyordu. `webrtc-signaling-validation.test.ts`'de 4 adet TODO olarak
işaretlenmişti.

### Yapılan

**`server/middleware/validate.ts`** — 2 yeni şema eklendi:

| Şema | Zorunlu alanlar |
|------|----------------|
| `dmCallSignal` | `callId` (string, 1-64), `targetUserId` (string, 1-64) |
| `gdmCallSignal` | `groupId` (string, 1-64), `targetSocketId` (string, 1-64) |

**`server/socket/handlers/dm.ts`** — 6 handler güncellendi:

```typescript
// Öncesi (doğrulama yok):
socket.on('dm:call:offer', ({ callId, targetUserId, offer }) => { ... });

// Sonrası:
socket.on('dm:call:offer', (payload) => {
  if (!validateSocketPayload(payload, socketSchemas.dmCallSignal).valid) return;
  const { callId, targetUserId, offer } = payload as { ... };
  ...
});
```

**`server/tests/webrtc-signaling-validation.test.ts`** — 4 TODO testi güncellendi:
- `expect(fwd).toBeDefined()` → `expect(fwd).toBeUndefined()` (bloklandı)
- Describe başlıkları "validation eksikliği (TODO)" → "validation (Sprint 75 ile düzeltildi)"

---

## 2. CSRF Bot Token Bypass — DB Hash Doğrulaması (Kritik Güvenlik)

### Sorun
`csrf.ts` `x-bot-token` / `x-api-key` header varlığını kontrol edince CSRF'yi atlıyordu.
Token ele geçirilirse koruma tamamen devre dışı kalıyordu; kodun kendi yorumunda da
bu risk belgelenmiş ama çözülmemişti.

### Yapılan

**`server/middleware/csrf.ts`** — `_verifyBotToken()` fonksiyonu eklendi:

```typescript
async function _verifyBotToken(token: string): Promise<boolean> {
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const bot = await db.bots.findOne({ tokenHash });
  return bot !== null;
}
```

Artık sadece header varlığı değil, **DB'deki SHA-256 hash eşleşmesi** zorunlu.
Geçersiz veya ele geçirilmiş token → bypass reddedilir → normal CSRF kontrolü uygulanır.

DB erişimi başarısız olursa (timeout, bağlantı kopması) güvenli taraf seçilir:
bypass izni verilmez.

---

## 3. ActivityPub DM — Aktör Kimlik Doğrulaması (Orta Güvenlik)

### Sorun
`handleApCreate` içinde federated DM alırken, `Users.findByApUrl(aUrl)` ile bulunan
yerel kullanıcının DB'deki `apUrl` alanı, aktivitedeki `actor` URL ile karşılaştırılmıyordu.
Nadir bir edge case: DB'de kayıtlı `apUrl` ile aktivite `actor`ı farklı olabilir.

### Yapılan

**`server/routes/federation/inbox-handlers.ts`** — aktör URL eşleşme kontrolü eklendi:

```typescript
if (senderApUrl && senderApUrl !== aUrl) {
  logger.warn({ actorUrl: aUrl, senderApUrl, event: 'federation.dm.actor_mismatch' });
  return; // impersonation girişimi — reddet
}
```

HTTP Signature inbox seviyesinde zaten doğrulanıyor; bu kontrol DB tutarlılığını
ikinci kat olarak garantiler.

---

## 4. i18n Breaking Change Dokümantasyonu

### Sorun
Sprint 72'de `setLang()` `void`'den `Promise<void>`'e, `LANGS` senkron tablodan
önbelleğe değişti. Migration kılavuzu yoktu; mevcut kodun kırılıp kırılmadığını
anlamak zordu.

### Yapılan

**`client/js/core/i18n.ts`** — dosya başına açık migration kılavuzu eklendi:

```
// ── Breaking changes (Sprint 72) ──────────────────────────────
// 1. setLang() artık void yerine Promise<void> döndürüyor.
//    - ESKİ (çalışmaya devam eder): onclick="i18n.setLang('en')"
//    - YENİ (await ile):            await i18n.setLang('en')
//
// 2. i18n.LANGS artık senkron tam tablo değil.
//    - ESKİ (bozulur):  i18n.LANGS.en['send']
//    - YENİ:            i18n.t('send')
```

---

## 5. Deployment Guide Genişletmesi

### Sorun
- DEPLOYMENT_GUIDE'da rate limit auto-ban davranışı eksik/yüzeysel belgeleniyordu.
- Swagger `/api/docs` CI sağlık kontrolü yoktu; bozulsa bile CI geçiyordu.
- Bot token güvenlik gereksinimleri belgelenmemişti.

### Yapılan

**`docs/DEPLOYMENT_GUIDE.md`** — 3 yeni bölüm eklendi:

| Bölüm | İçerik |
|-------|--------|
| §14 Swagger / API Dokümantasyonu | Kapsam kontrolü, CI entegrasyonu (`curl /api/docs → 200`) |
| §15 Güvenlik — Bot Token Yönetimi | Sprint 75 hash doğrulaması, rotasyon, auto-ban env vars |
| §16 Sorun Giderme | Eski §14 (aynı içerik, yeni numara) |

Rate limit auto-ban için eklenen detaylar:
- `RATE_LIMIT_BAN_THRESHOLD` ve `RATE_LIMIT_BAN_DURATION_MS` env vars belgelendi
- Ban tetikleme koşulları ve log formatı açıklandı
- Manuel ban yönetimi admin API endpoint'leri eklendi

---

## Dosya Değişim Özeti

| Dosya | Durum | Açıklama |
|-------|-------|----------|
| `server/middleware/validate.ts` | Değiştirildi | `dmCallSignal` + `gdmCallSignal` şemaları eklendi |
| `server/socket/handlers/dm.ts` | Değiştirildi | 6 WebRTC handler'a validation eklendi |
| `server/middleware/csrf.ts` | Değiştirildi | Bot token DB hash doğrulaması |
| `server/routes/federation/inbox-handlers.ts` | Değiştirildi | AP DM aktör URL eşleşme kontrolü |
| `client/js/core/i18n.ts` | Değiştirildi | Breaking change migration kılavuzu |
| `docs/DEPLOYMENT_GUIDE.md` | Değiştirildi | §14-§16 eklendi |
| `server/tests/webrtc-signaling-validation.test.ts` | Değiştirildi | 4 TODO testi güncellendi |

---

## Sprint 75 Sonrası Açık Maddeler

- Canary/blue-green deployment stratejisi (3 sprinttir açık)
- Monorepo tooling (Turborepo/Nx) değerlendirmesi
- TypeScript migration — `server/lib/` pure functions
- Swagger kapsam %74 → %80 hedefi (`federation/activitypub.ts`, `sso.ts` annotasyonu)
- Mediasoup SFU yük testi (k6 WebRTC eklentisi)
