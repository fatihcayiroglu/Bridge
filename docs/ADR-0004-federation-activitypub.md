# ADR-0004: Federation — ActivityPub Protokolü ve Erişim Kontrolü

## Status
Accepted (Sprint 29, güvenlik düzeltmeleri Sprint 52)

## Context

Bridge sunucularının birbirleriyle ve Mastodon / Pleroma gibi Fediverse uygulamalarıyla iletişim kurması için bir federation protokolü seçilmesi gerekiyordu. Değerlendirilen seçenekler:

1. **Matrix protokolü** — güçlü federation modeli, ancak Matrix homeserver implementasyonu mevcut Express/Node mimarisine uymayan ağır bir altyapı gerektirir.
2. **Özel federation API** — tam kontrol, ancak ekosistem yoktur; diğer yazılımlarla interoperabilite sıfırdır.
3. **ActivityPub (W3C Recommendation)** — Mastodon, Pleroma, Misskey ve diğer Fediverse uygulamalarıyla doğrudan uyumlu; WebFinger + HTTP Signature ile kimlik doğrulama standardize edilmiş.

## Decision

ActivityPub benimsendi. Her Bridge kullanıcısı `@kullanici@instance.domain` formatında bir AP Actor'dür. Inbox/Outbox, followers/following, WebFinger endpoint'leri implement edildi.

**HTTP Signature** zorunlu tutuldu: gelen tüm federation inbox istekleri `verifyHttpSignature()` ile doğrulanır; imzasız veya geçersiz imzalı istekler 401 ile reddedilir.

**Erişim Kontrolü (ACL):** Admin panelinden whitelist ve blacklist yönetimi yapılır. `checkFederationACL(domain)` her inbox isteğinde çalışır:
- Domain blacklist'teyse → 403, log kaydı.
- Whitelist modu aktifse ve domain listede değilse → 403.
- Aksi hâlde istek işlenir.

**AP Private Key Şifreleme:** ActivityPub imzalama anahtarları veritabanında plaintext saklanıyordu (Sprint 52 güvenlik açığı). Sprint 52'de AES-256-GCM ile şifrelenerek saklanmaya başlandı; migration `008_encrypt_ap_private_keys.sql` ile geriye dönük şifrelemesi yapıldı.

## Uygulama Detayları

| Bileşen | Dosya |
|---------|-------|
| Actor / WebFinger / Inbox / Outbox endpoint'leri | `server/routes/federation/activitypub.ts` |
| Delivery, Follow/Unfollow işleyicileri | `server/routes/federation/helpers.ts` |
| Peer yönetimi | `server/routes/federation/peers.ts` |
| Sosyal feed aktivity'leri | `server/routes/federation/social.ts` |
| ACL admin endpoint'leri | `server/routes/admin/federation-acl.ts` |
| HTTP Signature oluşturma/doğrulama | `server/lib/httpSignature.ts` |
| AP key şifreleme/çözme | `server/lib/apKeyEncryption.ts` |
| Federation heartbeat job | `server/jobs/federationHeartbeat.ts` |
| DB repository | `server/db/repositories/FederationRepository.ts` |
| Migration (key şifreleme) | `server/db/migrations_pg/008_encrypt_ap_private_keys.sql` |

## Consequences

**Olumlu:**
- Mastodon ve diğer Fediverse sunucularıyla standart ActivityPub üzerinden birlikte çalışabilirlik.
- HTTP Signature zorunluluğu replay attack ve domain spoofing riskini elimine eder.
- ACL whitelist/blacklist ile admin'ler güvenilmeyen instance'ları engelleyebilir.

**Olumsuz / Dikkat Edilecekler:**
- `INSTANCE_URL` ortam değişkeni doğru yapılandırılmazsa Actor URL'leri yanlış üretilir ve federation çalışmaz.
- AP private key'lerin şifrelenmesi için `AP_KEY_ENCRYPTION_SECRET` env'de tanımlı olmalıdır; eksikse server başlamaz (bkz. `server/lib/apKeyEncryption.ts`).
- HTTP Signature doğrulaması, actor'ün public key'ini uzak instance'tan çeker; bu fetch'in zaman aşımı `AbortSignal.timeout(8s)` ile sınırlandırılmıştır. Yüksek latency'li instance'lardan gelen istekler reddedilebilir.
- `cleanupUploads` ve `federationHeartbeat` job'ları doğru zamanlanmazsa eski peer kayıtları birikebilir.
- Matrix veya diğer federation protokolleriyle interoperabilite yoktur; yalnızca ActivityPub Fediverse ile uyumludur.
