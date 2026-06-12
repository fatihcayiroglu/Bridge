# ADR-0006: Federation Per-Peer Asymmetric Key Tasarımı

## Status
Proposed (Sprint 107)

## Bağlam

Bridge-to-Bridge federasyonu şu an HMAC-SHA256 + `FEDERATION_SECRET` kullanıyor.
Bu tasarımda iki önemli sınırlama var:

1. **Shared secret problemi**: Her peer aynı `FEDERATION_SECRET`'ı paylaşıyor (ya da Admin panelinde per-peer secret tanımlanıyor). Bir peer tehlikeye girerse diğer tüm peer'lar etkilenebilir.
2. **Reddedilemezlik (non-repudiation) yok**: HMAC ile her iki taraf da imza oluşturabileceğinden, bir peer "bu mesajı biz göndermedi" diyemez.

Bu ADR per-peer RSA-2048 (veya Ed25519) asymmetric key tasarımını değerlendiriyor.

## Karar Seçenekleri

### Seçenek A: Mevcut HMAC + Per-Peer Secret (Mevcut durum)

```
Bridge A → imzala(HMAC, sharedSecret) → Bridge B doğrula
```

**Artılar:** Basit, hızlı, uygulanmış durumda.
**Eksiler:** Shared secret, key rotation zor, reddedilemezlik yok.

### Seçenek B: Per-Peer RSA-2048 Asymmetric Key ✅ Önerilen

```
Bridge A → imzala(private_key_A) → Bridge B doğrula(public_key_A)
```

Her Bridge sunucusu:
- Kendi `privateKey` (sunucuda gizli, asla paylaşılmaz)
- Kendi `publicKey` (peer'larla paylaşılır, `GET /api/federation/info`'da yayımlanır)

**Avantajlar:**
- Bir peer'ın private key'i ele geçirilirse diğer peer'lar etkilenmez
- Non-repudiation: imzayı yalnızca sahibi oluşturabilir
- Key rotation bireysel peer bazında yapılabilir
- ActivityPub'ın mevcut HTTP Signature altyapısıyla uyumlu (zaten `apPublicKey` var)

**Dezavantajlar:**
- RSA-2048 imza/doğrulama HMAC'tan ~10× daha yavaş (Ed25519 ile azaltılabilir)
- İlk bağlantıda public key exchange gerekiyor

### Seçenek C: Ed25519 Per-Peer Key

Seçenek B ile aynı ama Ed25519 kullanıyor. RSA-2048'den ~100× daha hızlı, aynı güvenlik seviyesi.
Modern standard (Signal, WireGuard, SSH vb. kullanıyor).

**Önerilen uzun vadeli hedef:** Ed25519, ancak Node.js crypto desteği ve mevcut ActivityPub entegrasyonuyla uyum nedeniyle RSA-2048 geçiş aşaması uygun.

## Karar

**Seçenek B (RSA-2048)** uygulanacak, ardından **Seçenek C (Ed25519)**'a geçiş planlanacak.

### Uygulama Planı

#### Faz 1: Mevcut HMAC korunur, yeni anahtar altyapısı eklenir

```typescript
// GET /api/federation/info yanıtına eklenir
{
  "instanceUrl": "https://bridge-a.com",
  "publicKey": {
    "id": "https://bridge-a.com/api/federation/key",
    "owner": "https://bridge-a.com",
    "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n..."
  }
}
```

#### Faz 2: İstek imzalama

```typescript
// X-Bridge-Signature header'ı genişletilir:
// Eski: HMAC-SHA256=<hex>
// Yeni: RSA-SHA256 keyId="https://bridge-a.com/api/federation/key",signature=<base64>
```

Geriye dönük uyumluluk: HMAC header da eklenir — eski peer'lar HMAC ile doğrular, yeni peer'lar RSA ile.

#### Faz 3: HMAC deprecate edilir (Sprint 115+)

Tüm aktif peer'lar RSA'ya geçtikten sonra HMAC desteği kaldırılır.

### Key Saklama

- Server private key: `server_federation_keys` tablosunda AES-256-GCM ile şifreli (AP key rotasyon altyapısı yeniden kullanılır)
- Public key: `/api/federation/info`'dan erişilebilir (public)
- Key rotation runbook: `docs/FEDERATION_KEY_ROTATION_RUNBOOK.md` (Sprint 108)

### Güvenlik Notları

- Private key üretimi: uygulama başında yoksa otomatik üretilir
- Key rotation: Admin panelinden tetiklenebilir; yeni key peer'lara `POST /api/federation/key-update` ile duyurulur
- Replay koruması: mevcut 5 dakika timestamp toleransı korunur
- `keyId` URL'si karşı sunucudan fetch edilip doğrulanır (key pinning opsiyonel)

## Sonuçlar

- Sprint 107: Bu ADR onaylandı, `GET /api/federation/info` key yayımlamaya başladı
- Sprint 108: İmza/doğrulama katmanı ✅ — `httpSignatureV2.ts` RSA öncelikli doğrulama, `federationAuth.ts` middleware (25 test)
- Sprint 109: Prod peer'larla test, HMAC parallel mode
- Sprint 115+: HMAC deprecated

## İlgili Dosyalar

- `server/routes/federation/peers.ts` — peer yönetimi
- `server/routes/federation/activitypub.ts` — mevcut AP key altyapısı
- `server/lib/apKeyEncryption.ts` — AES-256-GCM key şifreleme (yeniden kullanılacak)
- `docs/AP_ENCRYPTION_KEY_ROTATION_RUNBOOK.md` — referans runbook
- `server/lib/httpSignatureV2.ts` — RSA-2048 doğrulama ve imzalama (Sprint 108)
- `server/middleware/federationAuth.ts` — federation auth middleware (Sprint 108)
- `server/tests/httpSignatureV2.test.ts` — 25 birim testi (Sprint 108)
