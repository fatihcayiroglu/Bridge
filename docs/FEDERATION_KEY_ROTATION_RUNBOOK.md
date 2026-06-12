# RUNBOOK: Federation RSA Key Rotasyonu (ADR-0006 Faz 2)

**Kapsam:** Bridge instance federation RSA-2048 key çifti (`server/lib/federationKeys.ts`)  
**Algoritma:** RSA-SHA256 imza — `X-Bridge-Signature: RSA-SHA256 keyId="...",signature="..."`  
**Veritabanı:** `server_federation_keys` (tek satır: `_id = 'instance'`)  
**Private key şifreleme:** AES-256-GCM (`AP_ENCRYPTION_KEY` — `apKeyEncryption.ts` formatı)

---

## Ne Zaman Rotate Edilir?

| Durum | Öncelik |
|---|---|
| Private key sızıntı şüphesi | **Acil** |
| Peer'ların imza doğrulama hataları (key mismatch) | **Acil** |
| Rutin periyodik rotasyon (yıllık) | Normal |
| `AP_ENCRYPTION_KEY` rotasyonu sonrası (şifreli blob yeniden yazımı) | Normal |
| HMAC → RSA tam geçiş öncesi (Sprint 109+) | Planlı |

---

## Ön Koşullar

```bash
# 1. Mevcut federation key kaydını doğrula
psql "$DATABASE_URL" -c "
  SELECT _id, \"keyVersion\", \"createdAt\", \"rotatedAt\",
         LEFT(\"publicKeyPem\", 40) AS pub_preview
  FROM server_federation_keys;"

# Beklenen: tek satır (_id = instance), keyVersion >= 1

# 2. Aktif peer sayısını kontrol et
psql "$DATABASE_URL" -c "
  SELECT status, COUNT(*) FROM federation_peers GROUP BY status;"

# 3. Instance URL doğrula (keyId buna bağlı)
echo "$INSTANCE_URL"
# Örnek: https://bridge.example.com
# keyId = ${INSTANCE_URL}/api/federation/key

# 4. AP_ENCRYPTION_KEY mevcut ve geçerli (64-char hex)
node -e "
  const k = process.env.AP_ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(k)) { console.error('AP_ENCRYPTION_KEY geçersiz'); process.exit(1); }
  console.log('AP_ENCRYPTION_KEY OK');
"
```

---

## Rotasyon Stratejisi (ADR-0006 Faz 2 — Paralel Mod)

Faz 2'de hem HMAC hem RSA header'ları birlikte gönderilir. Rotasyon sırası:

1. **Yeni RSA key üret** — sunucu yeniden başlatılmadan önce peer'lara duyurulabilir
2. **Paralel doğrulama penceresi** — peer'lar yeni `publicKeyPem`'i `GET /api/federation/info`'dan alır
3. **Eski key'i devre dışı bırak** — tüm peer'lar yeni key ile doğruladıktan sonra (Sprint 115+'da HMAC kaldırılır)

> **Önemli:** Rotasyon sırasında `INSTANCE_URL` değişmemeli. Değişecekse önce DNS/TLS güncellemesi yapın, sonra key rotasyonu.

---

## Adım 1 — Yeni RSA Key Çifti Üret ve Kaydet

### Seçenek A: Admin API (önerilen — Sprint 108+)

```bash
curl -s -X POST "https://<SUNUCU>/api/admin/federation/rotate-key" \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" | jq .
```

Beklenen yanıt:
```json
{
  "ok": true,
  "keyId": "https://bridge.example.com/api/federation/key",
  "keyVersion": 2,
  "rotatedAt": 1717084800000
}
```

### Seçenek B: Manuel script

```bash
cd server
AP_ENCRYPTION_KEY="$AP_ENCRYPTION_KEY" \
DATABASE_URL="$DATABASE_URL" \
INSTANCE_URL="https://bridge.example.com" \
node scripts/rotate-federation-keys.js
```

Beklenen çıktı:
```
[rotate-federation-keys] Yeni RSA-2048 key çifti üretildi.
[rotate-federation-keys] server_federation_keys güncellendi (keyVersion=2).
[rotate-federation-keys] publicKeyPem: -----BEGIN PUBLIC KEY-----...
[rotate-federation-keys] In-memory cache temizlendi — sunucu restart gerekli.
```

---

## Adım 2 — Peer'lara Yeni Public Key Duyur

Her aktif peer'a yeni public key'i bildirin:

```bash
# Peer listesini al
psql "$DATABASE_URL" -c "
  SELECT url, status FROM federation_peers WHERE status = 'active';"

# Her peer için key-update (Sprint 108 endpoint)
curl -s -X POST "https://<PEER_URL>/api/federation/key-update" \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Signature: $(node scripts/sign-federation-body.js)" \
  -d '{
    "instanceUrl": "https://bridge.example.com",
    "publicKey": {
      "id": "https://bridge.example.com/api/federation/key",
      "owner": "https://bridge.example.com",
      "publicKeyPem": "<YENİ_PEM>"
    }
  }'
```

Alternatif: Peer'lar bir sonraki `GET /api/federation/info` çağrısında yeni key'i otomatik alır (TTL cache varsa bekleme süresi uygulanır).

---

## Adım 3 — Sunucuyu Yeniden Başlat

In-memory key cache (`_cached` in `federationKeys.ts`) restart gerektirir:

```bash
# PM2
pm2 restart bridge-server

# Docker Compose
docker compose up -d --force-recreate server

# Kubernetes
kubectl rollout restart deployment/bridge-server -n bridge
```

---

## Adım 4 — Doğrulama

```bash
# 1. Public key endpoint
curl -s "https://<SUNUCU>/api/federation/info" | jq '.publicKey'
# Beklenen: yeni publicKeyPem, keyId doğru URL

# 2. Key dokümanı
curl -s "https://<SUNUCU>/api/federation/key" | jq '.publicKey.publicKeyPem' | head -1
# Beklenen: -----BEGIN PUBLIC KEY-----

# 3. İmza üretimi testi (yerel)
cd server && npm test -- federation-rsa.test.ts

# 4. Peer ping — RSA imza ile
curl -s -X POST "https://<PEER>/api/federation/ping" \
  -H "Content-Type: application/json" \
  -H "X-Bridge-Signature: RSA-SHA256 keyId=\"https://<SUNUCU>/api/federation/key\",signature=\"<SIG>\"" \
  -H "x-bridge-ts: $(date +%s)000" \
  -d '{"url":"https://<SUNUCU>"}'
# Beklenen: 200 OK

# 5. Log kontrolü
pm2 logs bridge-server --lines 100 | grep -E "federation|signature|key"
# Beklenen: verify hatası YOK

# 6. DB doğrulama
psql "$DATABASE_URL" -c "
  SELECT \"keyVersion\", \"rotatedAt\"
  FROM server_federation_keys WHERE _id = 'instance';"
```

---

## Acil Durum: Private Key Tehlikeye Girdi

```bash
# 1. HEMEN rotate et (Adım 1)
# 2. Tüm aktif peer bağlantılarını geçici durdur
psql "$DATABASE_URL" -c "
  UPDATE federation_peers SET status = 'suspended' WHERE status = 'active';"

# 3. AP_ENCRYPTION_KEY de şüpheliyse AP runbook'u da uygula
#    docs/AP_ENCRYPTION_KEY_ROTATION_RUNBOOK.md

# 4. Olay kaydı: tarih, etki, rotate zamanı, etkilenen peer'lar

# 5. Peer'ları tek tek yeniden onayla ve key-update gönder
```

---

## Rollback

Yeni key ile sorun çıkarsa (peer'lar henüz güncellenmediyse):

```bash
# 1. DB yedeğinden eski kaydı geri yükle
psql "$DATABASE_URL" -c "
  UPDATE server_federation_keys
  SET \"publicKeyPem\" = '<ESKİ_PEM>',
      \"privateKeyEnc\" = '<ESKİ_ENC>',
      \"keyVersion\" = 1,
      \"rotatedAt\" = NULL
  WHERE _id = 'instance';"

# 2. Sunucuyu yeniden başlat
pm2 restart bridge-server

# 3. Peer'lara eski public key'i tekrar duyur
```

> **Uyarı:** Private key tamamen kayıpsa rollback mümkün değildir — yeni key üretip tüm peer'ları yeniden kaydetmeniz gerekir.

---

## `rotate-federation-keys.js` Script

Script henüz yoksa `server/scripts/rotate-federation-keys.js` olarak oluşturun:

```js
#!/usr/bin/env node
// server/scripts/rotate-federation-keys.js
// ADR-0006 Faz 2: Instance RSA federation key rotasyonu
//
// Kullanım:
//   AP_ENCRYPTION_KEY=<64_hex> DATABASE_URL=postgresql://... \
//   INSTANCE_URL=https://bridge.example.com \
//   node server/scripts/rotate-federation-keys.js

'use strict';

const crypto = require('crypto');
const { Pool } = require('pg');

const ENC_HEX = process.env.AP_ENCRYPTION_KEY;
const DB_URL  = process.env.DATABASE_URL;
const INSTANCE_ID = 'instance';

if (!ENC_HEX || !/^[0-9a-fA-F]{64}$/.test(ENC_HEX)) {
  console.error('[rotate-federation-keys] AP_ENCRYPTION_KEY geçersiz (64-char hex)');
  process.exit(1);
}
if (!DB_URL) {
  console.error('[rotate-federation-keys] DATABASE_URL eksik');
  process.exit(1);
}

const ENC_KEY = Buffer.from(ENC_HEX, 'hex');
const ALG = 'aes-256-gcm', IV_LEN = 12, TAG_LEN = 16;

function encryptPrivateKey(pem) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALG, ENC_KEY, iv);
  const enc = Buffer.concat([cipher.update(pem, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

async function main() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

  const privateKeyEnc = encryptPrivateKey(privateKey);
  const now = Date.now();
  const pool = new Pool({ connectionString: DB_URL });

  const existing = await pool.query(
    'SELECT "keyVersion" FROM server_federation_keys WHERE _id = $1', [INSTANCE_ID],
  );
  const nextVersion = existing.rows[0] ? (existing.rows[0].keyVersion + 1) : 1;

  if (existing.rows.length) {
    await pool.query(
      `UPDATE server_federation_keys
       SET "publicKeyPem" = $1, "privateKeyEnc" = $2, "keyVersion" = $3, "rotatedAt" = $4
       WHERE _id = $5`,
      [publicKey, privateKeyEnc, nextVersion, now, INSTANCE_ID],
    );
  } else {
    await pool.query(
      `INSERT INTO server_federation_keys (_id, "publicKeyPem", "privateKeyEnc", "keyVersion", "createdAt")
       VALUES ($1, $2, $3, $4, $5)`,
      [INSTANCE_ID, publicKey, privateKeyEnc, nextVersion, now],
    );
  }

  console.log(`[rotate-federation-keys] Tamamlandı (keyVersion=${nextVersion}).`);
  console.log('[rotate-federation-keys] Sunucuyu yeniden başlatın.');
  await pool.end();
}

main().catch(err => {
  console.error('[rotate-federation-keys] Fatal:', err.message);
  process.exit(1);
});
```

---

## İlgili Dosyalar

| Dosya | Açıklama |
|---|---|
| `docs/ADR-0006-federation-per-peer-asymmetric-keys.md` | Tasarım kararı ve faz planı |
| `server/lib/federationKeys.ts` | Key üretimi, cache, imza |
| `server/lib/httpSignature.ts` | RSA + HMAC doğrulama (Faz 2 paralel mod) |
| `server/lib/apKeyEncryption.ts` | Private key AES-256-GCM şifreleme |
| `server/routes/federation/peers.ts` | `GET /api/federation/info`, peer yönetimi |
| `server/db/migrations_pg/015_server_federation_keys.sql` | Tablo migration |
| `docs/AP_ENCRYPTION_KEY_ROTATION_RUNBOOK.md` | AP key rotasyonu (referans) |
| `server/tests/federation-rsa.test.ts` | RSA imza birim testleri |

---

*Son güncelleme: Sprint 107 — Bridge (ADR-0006 Faz 2 runbook)*
