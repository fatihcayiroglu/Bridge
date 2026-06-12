# RUNBOOK: AP_ENCRYPTION_KEY Rotasyonu

**Kapsam:** ActivityPub private key şifrelemesi (`server/lib/apKeyEncryption.ts`)  
**Algoritma:** AES-256-GCM — format: `base64(iv[12] || authTag[16] || ciphertext)`  
**Veritabanı:** `user_ap_keys.apPrivateKeyEnc` (keyVersion=1)

---

## Ne Zaman Rotate Edilir?

| Durum | Öncelik |
|---|---|
| Anahtar tehlikeye girdi (sızıntı şüphesi) | **Acil** |
| Rutin periyodik rotasyon (yıllık) | Normal |
| Sunucu/ortam değişikliği | Normal |
| Ekip üyesi ayrıldı (anahtara erişim vardı) | Normal |

---

## Ön Koşullar

```bash
# 1. Mevcut durumu doğrula — tüm kayıtlar keyVersion=1 olmalı
psql "$DATABASE_URL" -c "
  SELECT keyVersion, COUNT(*) 
  FROM user_ap_keys 
  GROUP BY keyVersion;"

# Beklenen çıktı:
#  keyVersion | count
# ------------+-------
#           1 |  <N>

# 2. Yeni anahtarı üret
NEW_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
echo "YENİ ANAHTAR: $NEW_KEY"
# → Güvenli bir yere kaydet (password manager / vault)
```

---

## Adım 1 — Yeni Şifreli Blobları Üret

Tüm kayıtları mevcut anahtarla çöz, yeni anahtarla tekrar şifrele.

```bash
# server/ dizininde çalıştır
AP_ENCRYPTION_KEY_OLD="<ESKİ_ANAHTAR>" \
AP_ENCRYPTION_KEY_NEW="<YENİ_ANAHTAR>" \
DATABASE_URL="$DATABASE_URL" \
node scripts/rotate-ap-keys.js
```

> **Not:** `rotate-ap-keys.js` henüz yoksa aşağıdaki [Script](#rotate-ap-keysjs) bölümüne bak.

Beklenen çıktı:
```
[rotate-ap-keys] 42 kayıt yeniden şifrelenecek...
[rotate-ap-keys] Tamamlandı: 42 başarılı, 0 başarısız.
[rotate-ap-keys] Tüm kayıtlar yeni anahtarla şifrelendi.
```

---

## Adım 2 — Yeni Anahtarı Ortam Değişkenine Yaz

### Docker Compose

```yaml
# docker-compose.yml veya .env
AP_ENCRYPTION_KEY=<YENİ_ANAHTAR>
```

### PM2 / ecosystem.config.js

```js
env: {
  AP_ENCRYPTION_KEY: '<YENİ_ANAHTAR>',
}
```

### Kubernetes Secret

```bash
kubectl create secret generic bridge-secrets \
  --from-literal=AP_ENCRYPTION_KEY="<YENİ_ANAHTAR>" \
  --dry-run=client -o yaml | kubectl apply -f -
```

---

## Adım 3 — Sunucuyu Yeniden Başlat

```bash
# PM2
pm2 restart bridge-server

# Docker Compose
docker compose up -d --force-recreate server

# Kubernetes
kubectl rollout restart deployment/bridge-server
```

---

## Adım 4 — Doğrulama

```bash
# 1. Sunucu başladı mı?
pm2 status  # veya docker compose ps

# 2. Log'larda hata yok mu?
pm2 logs bridge-server --lines 50 | grep -E "ap_key|FATAL|WARN"
# Beklenen: hiçbir ap_key.missing / ap_key.invalid uyarısı YOK

# 3. Federation çalışıyor mu?
curl -s https://<SUNUCU>/health | jq .federation
# Beklenen: "ok" veya "enabled"

# 4. DB'de eski anahtar kalmadı mı?
psql "$DATABASE_URL" -c "
  SELECT COUNT(*) as unencrypted
  FROM user_ap_keys
  WHERE keyVersion = 0 OR keyVersion IS NULL;"
# Beklenen: 0
```

---

## Acil Durum: Anahtar Tehlikeye Girdi

Standart rotasyona ek olarak:

```bash
# 1. Etkilenen kullanıcıların AP key pair'lerini yeniden üret
#    (private key dışarıya sızdıysa imzalama tehlikeye girdi)
AP_ENCRYPTION_KEY=<YENİ_ANAHTAR> \
DATABASE_URL=$DATABASE_URL \
node scripts/backfill-ap-keys.ts --regenerate-all

# 2. Federation peer'larına bildirim gönder (opsiyonel)
#    Büyük bir instance'sa ActivityPub Update activity gönderilebilir.

# 3. Olay kaydı tut — tarih, etki kapsamı, yapılan işlemler
```

---

## Rollback

Rotasyon sonrası sorun çıkarsa eski anahtara dön:

```bash
# 1. .env'de eski anahtarı geri yaz
AP_ENCRYPTION_KEY=<ESKİ_ANAHTAR>

# 2. Yeniden şifreleme yapıldıysa geri al
AP_ENCRYPTION_KEY_OLD="<YENİ_ANAHTAR>" \
AP_ENCRYPTION_KEY_NEW="<ESKİ_ANAHTAR>" \
DATABASE_URL=$DATABASE_URL \
node scripts/rotate-ap-keys.js

# 3. Sunucuyu yeniden başlat
pm2 restart bridge-server
```

---

## `rotate-ap-keys.js` Script

Bu script henüz `server/scripts/` altında yoksa aşağıdaki içerikle oluştur:

```js
#!/usr/bin/env node
// server/scripts/rotate-ap-keys.js
// AP_ENCRYPTION_KEY rotasyonu: tüm kayıtları yeni anahtarla yeniden şifreler.
//
// Kullanım:
//   AP_ENCRYPTION_KEY_OLD=<eski_hex> \
//   AP_ENCRYPTION_KEY_NEW=<yeni_hex> \
//   DATABASE_URL=postgresql://... \
//   node server/scripts/rotate-ap-keys.js

'use strict';

const { createCipheriv, createDecipheriv, randomBytes } = require('crypto');
const { Pool } = require('pg');

const OLD_HEX = process.env.AP_ENCRYPTION_KEY_OLD;
const NEW_HEX = process.env.AP_ENCRYPTION_KEY_NEW;

if (!OLD_HEX || !/^[0-9a-fA-F]{64}$/.test(OLD_HEX)) {
  console.error('AP_ENCRYPTION_KEY_OLD eksik veya geçersiz (64-char hex)');
  process.exit(1);
}
if (!NEW_HEX || !/^[0-9a-fA-F]{64}$/.test(NEW_HEX)) {
  console.error('AP_ENCRYPTION_KEY_NEW eksik veya geçersiz (64-char hex)');
  process.exit(1);
}

const OLD_KEY = Buffer.from(OLD_HEX, 'hex');
const NEW_KEY = Buffer.from(NEW_HEX, 'hex');
const ALG     = 'aes-256-gcm';
const IV_LEN  = 12, TAG_LEN = 16;

function decrypt(encoded, key) {
  const buf = Buffer.from(encoded, 'base64');
  const iv  = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct  = buf.subarray(IV_LEN + TAG_LEN);
  const dec = createDecipheriv(ALG, key, iv);
  dec.setAuthTag(tag);
  return dec.update(ct) + dec.final('utf8');
}

function encrypt(plaintext, key) {
  const iv     = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALG, key, iv);
  const enc    = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const { rows } = await pool.query(
    `SELECT "userId", "apPrivateKeyEnc"
     FROM user_ap_keys
     WHERE "keyVersion" = 1 AND "apPrivateKeyEnc" IS NOT NULL`
  );

  if (rows.length === 0) {
    console.log('[rotate-ap-keys] Rotate edilecek kayıt yok.');
    await pool.end(); return;
  }

  console.log(`[rotate-ap-keys] ${rows.length} kayıt yeniden şifrelenecek...`);
  let success = 0, failed = 0;

  for (const row of rows) {
    try {
      const plain  = decrypt(row.apPrivateKeyEnc, OLD_KEY);
      const newEnc = encrypt(plain, NEW_KEY);
      await pool.query(
        `UPDATE user_ap_keys SET "apPrivateKeyEnc" = $1, "updatedAt" = $2 WHERE "userId" = $3`,
        [newEnc, Date.now(), row.userId]
      );
      success++;
    } catch (err) {
      console.error(`HATA userId=${row.userId}:`, err.message);
      failed++;
    }
  }

  console.log(`[rotate-ap-keys] Tamamlandı: ${success} başarılı, ${failed} başarısız.`);
  if (failed > 0) process.exitCode = 1;
  await pool.end();
}

main().catch(err => { console.error('[rotate-ap-keys] Fatal:', err); process.exit(1); });
```

---

## Referanslar

| Dosya | Açıklama |
|---|---|
| `server/lib/apKeyEncryption.ts` | Şifreleme/çözme çekirdek kütüphanesi |
| `server/scripts/encrypt-ap-keys.js` | İlk şifreleme (düz metin → v1) |
| `server/db/migrations_pg/008_encrypt_ap_private_keys.sql` | keyVersion sütunu migration |
| `server/db/migrations_pg/009_drop_ap_private_key_plaintext.sql` | Eski plain kolon temizleme |
| `AP_ENCRYPTION_KEY` env | 64-char hex, 32-byte AES-256 key |

---

*Son güncelleme: Sprint 38 — Bridge*
