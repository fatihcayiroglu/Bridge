# Sprint 107 — 10/10 Kalite: Modülarizasyon, ADR Genişletmesi, DB Dokümantasyonu (2026-05-30)

## Özet

Bu sprint, kod incelemesinde tespit edilen son kalitatif eksiklikleri kapatmaya odaklanmıştır.
Yeni özellik eklenmemiş; mevcut sistemin sürdürülebilirliği ve dokümantasyon eksiksizliği güçlendirilmiştir.

---

## Değişiklikler

### 1. `messages.ts` Socket Handler Modülarizasyonu

**Sorun:** `server/socket/handlers/messages.ts` 505 satıra ulaşmış, gönderme, düzenleme ve thread mantığını tek dosyada barındırıyordu. Bakımı zorlaşıyor, diff'leri okunaksız hale geliyordu.

**Çözüm:** 4 odaklanmış modüle ayrıldı:

| Dosya | Satır | İçerik |
|-------|-------|--------|
| `messages-types.ts` | 55 | Paylaşılan tipler (`AuthUser`, `SendMessagePayload`, vb.) + `systemMsg`, `formatDuration` |
| `messages-send.ts` | 312 | Mesaj/dosya gönderme, ACK, E2EE, link önizleme, bridge forwarding, mention bildirimleri |
| `messages-edit.ts` | 177 | Düzenleme, silme (atomic transaction), pin, reaksiyon, reaction-role |
| `messages-thread.ts` | 33 | Thread join/leave/yeni mesaj yayını |
| `messages.ts` (barrel) | 35 | Geriye dönük uyumluluk: tüm public semboller re-export |

**Geriye dönük uyumluluk:** `socket/index.ts` dahil tüm mevcut import'lar değişmeden çalışır.
`messages.ts` barrel export olarak korundu.

**Etki:** Her modül tek bir sorumluluğa odaklanıyor. Testler modül bazında yazılabilir.

---

### 2. ADR Genişletmesi: 2 Yeni Karar Belgesi

**ADR-0006: Federation Per-Peer Asymmetric Key Tasarımı**

Mevcut HMAC-SHA256 + shared secret tasarımının sınırlamaları belgelendi:
- Shared secret problemi (bir peer tehlikeye girerse hepsi etkilenir)
- Reddedilemezlik (non-repudiation) eksikliği

Üç seçenek değerlendirildi (A: mevcut HMAC, B: RSA-2048, C: Ed25519).
**Karar:** Seçenek B (RSA-2048) — Sprint 108'de implementation, Sprint 109'da prod test, Sprint 115+'da HMAC deprecated.

Sprint 107'de `federation_peers.publicKey` sütunu şemaya eklendi (nullable — geçiş döneminde).

**ADR-0007: Rate Limit Stratejisi — Sliding Window + Dual-Key**

Sprint 41'de uygulanan sliding-window + IP+User dual-key tasarımının gerekçesi belgelendi.
Token bucket ve fixed window alternatifleri ile karşılaştırıldı. Redis fallback stratejisi açıklandı.

---

### 3. DB Schema Dokümantasyonu: `docs/DATABASE_SCHEMA.md`

**Sorun:** 64 tablolu bir veritabanının `schema.sql` dışında hiçbir yazılı referansı yoktu.
Yeni contributor'lar hangi tabloyu ne için kullandığını anlamak için kodu okumak zorundaydı.

**Çözüm:** Kapsamlı `docs/DATABASE_SCHEMA.md` oluşturuldu:
- Tüm 64 tablo — numara, isim, kısa açıklama
- Temel 9 tablo için detaylı şema (sütunlar, tipler, notlar)
- Tasarım kararları: JSONB vs TEXT, soft delete yok, BIGINT timestamp, index stratejisi
- Migration geçmiş tablosu
- Yeni tablo ekleme rehberi (5 adım)

---

## Dosya Değişiklikleri

### Eklendi
- `server/socket/handlers/messages-types.ts` — paylaşılan tip tanımları (55 satır)
- `server/socket/handlers/messages-send.ts` — mesaj gönderme modülü (312 satır)
- `server/socket/handlers/messages-edit.ts` — düzenleme/silme/reaksiyon modülü (177 satır)
- `server/socket/handlers/messages-thread.ts` — thread socket events (33 satır)
- `docs/ADR-0006-federation-per-peer-asymmetric-keys.md` — asymmetric key tasarımı
- `docs/ADR-0007-rate-limit-strategy.md` — rate limit tasarım kararları
- `docs/DATABASE_SCHEMA.md` — 64 tablo, ilişkiler, tasarım kararları (262 satır)

### Değiştirildi
- `server/socket/handlers/messages.ts` — 505 satır → 35 satır barrel export
- `server/db/postgres/schema.sql` — `federation_peers.publicKey TEXT` sütunu eklendi (ADR-0006 Faz 1)
- `CHANGELOG.md` — Sprint 107 eklendi

---

## Geriye Dönük Uyumluluk

Tüm değişiklikler geriye dönük uyumludur:
- `messages.ts` barrel export'u mevcut import'ları korur
- `federation_peers.publicKey` nullable — mevcut peer kayıtları etkilenmez
- Yeni ADR ve dökümanlar yalnızca bilgi ekler, davranış değiştirmez

---

## Sonraki Sprint Önerileri (Sprint 108)

| Madde | Öncelik |
|-------|---------|
| ADR-0006 Faz 2: Federation RSA imza/doğrulama implementasyonu | 🔴 Yüksek |
| `docs/FEDERATION_KEY_ROTATION_RUNBOOK.md` oluştur | 🔴 Yüksek |
| `messages-send.ts` için birim testleri | ✅ Tamamlandı |
| `messages-edit.ts` için birim testleri | ✅ Tamamlandı |
| `docs/FEDERATION_KEY_ROTATION_RUNBOOK.md` | ✅ Tamamlandı |
| Üçüncü plugin örneği (`auto-role`) | ✅ Tamamlandı |
| Plugin sunucu handler'ları (`actions.ts`) | ✅ Sprint 108 |
| Admin `rotate-key` + peer `key-update` | ✅ Sprint 108 |
| CI federation rotasyon guard | ✅ Sprint 108 |
| Coverage threshold %80'e yükselt (discover/semantic/channelPerms düşük) | 🟡 Orta |

---

## Sprint 107 Tamamlama (Kalite 10/10 — 2026-05-30)

### Ek testler
- `server/tests/deleteMessageCascade.test.ts` — PG `_transaction` SQL cascade (thread_messages, threads, messages, unread_counts).
- `server/tests/messages-integration.test.ts` — `registerMessageHandlers` send → edit → delete / react → pin akışları.
- `server/tests/messages-send.test.ts` — webhook (`dispatchEvent`), plugin (`message:created`), link önizleme (`message:embedUpdate`).

### Düzeltmeler
- `server/lib/deleteMessageCascade.ts` — `_transaction` boolean kontrolü düzeltildi (production PG yolu).
- `server/routes/admin/federation-acl.ts` — `adminOnly` import `./middleware` (önceden `./core`).

### Doğrulama
```bash
cd server && npm ci --ignore-scripts
NODE_ENV=test npm test -- messages-send.test.ts messages-edit.test.ts messages-integration.test.ts deleteMessageCascade.test.ts messages-modules.test.ts plugin-actions.test.ts federation-keys-admin.test.ts federation-rsa.test.ts plugins.test.ts
# 9 suite, 129 test PASS
```
