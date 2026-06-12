# Medya Depolama Migration Rehberi
_Local disk'ten S3/R2/MinIO/B2'ye geçiş — Sprint 73_

---

## Genel Bakış

Bridge varsayılan olarak dosyaları `server/uploads/` dizininde saklar.
Bu rehber production'da bir nesne depolama backend'ine geçiş adımlarını anlatır.

Geçişin tamamı 4 adımdır:
1. Backend seç ve kimlik bilgilerini hazırla
2. SDK'yı kur
3. `.env` dosyasını güncelle
4. Mevcut dosyaları taşı (opsiyonel)

---

## Adım 1 — Backend seçimi

| Backend | En iyi kullanım |
|---------|----------------|
| **Cloudflare R2** | Egress ücretsiz, Cloudflare kullananlar için |
| **AWS S3** | AWS altyapısı mevcutsa |
| **MinIO** | Tamamen self-hosted, Kubernetes ortamı |
| **Backblaze B2** | Düşük maliyet, S3-uyumlu |

---

## Adım 2 — SDK kurulumu

Tüm remote backend'ler aynı SDK'yı kullanır:

```bash
cd server
npm install @aws-sdk/client-s3
```

Local modda bu paket gerekmez — yüklemek zorunda değilsiniz.

---

## Adım 3 — `.env` yapılandırması

### Cloudflare R2

```env
CDN_PROVIDER=r2
R2_ACCOUNT_ID=your_cloudflare_account_id
R2_ACCESS_KEY_ID=your_r2_api_token_key_id
R2_SECRET_ACCESS_KEY=your_r2_api_token_secret
R2_BUCKET=bridge-uploads
R2_PUBLIC_URL=https://uploads.yourdomain.com
# R2_PUBLIC_URL: Custom Domain veya https://<token>.r2.dev şeklinde
```

R2 bucket'ı oluştururken "Public Access" veya Custom Domain yapılandırın.
API token'ı "R2 Token" → "Edit" → bucket için "Object Read & Write" izniyle oluşturun.

### AWS S3

```env
CDN_PROVIDER=s3
S3_BUCKET=bridge-uploads
S3_REGION=eu-central-1
S3_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE
S3_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
S3_PUBLIC_URL=https://bridge-uploads.s3.eu-central-1.amazonaws.com
# S3_PUBLIC_URL: CloudFront kullanıyorsanız CloudFront URL'sini girin
```

Bucket policy'de public read veya CloudFront OAC yapılandırmanız gerekir.

### MinIO (Docker Compose)

`docker-compose.yml`'e MinIO servisi ekleyin:

```yaml
services:
  minio:
    image: minio/minio:latest
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    volumes:
      - minio_data:/data
    ports:
      - "9000:9000"
      - "9001:9001"

volumes:
  minio_data:
```

```env
CDN_PROVIDER=minio
MINIO_ENDPOINT=http://minio:9000
MINIO_BUCKET=bridge-uploads
MINIO_ACCESS_KEY=minioadmin
MINIO_SECRET_KEY=minioadmin
MINIO_PUBLIC_URL=http://localhost:9000/bridge-uploads
# Production'da MINIO_PUBLIC_URL bir reverse proxy (nginx/caddy) arkasında olmalı
```

MinIO Console (`:9001`) üzerinden bucket'ı oluşturun ve "Public" policy atayın.

### Backblaze B2

```env
CDN_PROVIDER=b2
B2_BUCKET_NAME=bridge-uploads
B2_KEY_ID=your_application_key_id
B2_APP_KEY=your_application_key
B2_REGION=us-west-004
# B2_PUBLIC_URL opsiyonel; Cloudflare proxy ile kullanıyorsanız:
B2_PUBLIC_URL=https://uploads.yourdomain.com
```

B2 Console'da "Application Keys" → "Add a New Application Key" ile
bucket'a "Read and Write" erişimli key oluşturun.

---

## Adım 4 — Mevcut dosyaların taşınması

Geçiş öncesi `server/uploads/` altındaki dosyaları seçtiğiniz backend'e yükleyin.

### R2 / S3 / B2 için — AWS CLI

```bash
# AWS CLI kurulumu
pip install awscli

# R2 örneği
aws s3 sync server/uploads/ s3://bridge-uploads/uploads/ \
  --endpoint-url https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com \
  --access-key <R2_ACCESS_KEY_ID> \
  --secret-key <R2_SECRET_ACCESS_KEY>

# S3 örneği
aws s3 sync server/uploads/ s3://bridge-uploads/uploads/ \
  --region eu-central-1

# B2 örneği (B2 S3-uyumlu API)
aws s3 sync server/uploads/ s3://bridge-uploads/uploads/ \
  --endpoint-url https://s3.us-west-004.backblazeb2.com
```

### MinIO için — mc (MinIO Client)

```bash
# mc kurulumu
brew install minio/stable/mc  # macOS
# veya: wget https://dl.min.io/client/mc/release/linux-amd64/mc

mc alias set local-minio http://localhost:9000 minioadmin minioadmin
mc cp --recursive server/uploads/ local-minio/bridge-uploads/uploads/
```

---

## Veritabanı URL'leri

Mevcut `uploads` sütunlarındaki `/uploads/<filename>` URL'leri değişmez —
`storageAdapter.keyFromUrl()` yeni backend URL formatlarını da çözer.

Ancak mesajlardaki **eski URL'ler** local'e işaret eder. Eğer local disk kaldırılacaksa
bir migration scripti gerekir:

```sql
-- Örnek: PostgreSQL — URL prefix'ini güncelle
UPDATE messages
SET content = REPLACE(content, '/uploads/', 'https://uploads.yourdomain.com/uploads/')
WHERE content LIKE '%/uploads/%';

UPDATE users
SET avatar = REPLACE(avatar, '/uploads/', 'https://uploads.yourdomain.com/uploads/')
WHERE avatar LIKE '/uploads/%';
```

Bu sorguları uygulamadan önce veritabanını yedekleyin.

---

## Sağlık Kontrolü

Sunucu başlarken `storageAdapter` depolama bağlantısını test eder.
Loglarda şunu görmelisiniz:

```
[storageAdapter] Cloudflare R2 kullanılıyor provider=r2
```

Manuel test için:

```bash
curl -X GET http://localhost:3000/api/health
# "storage": "ok" döndürmeli
```

---

## Geri Alma

`CDN_PROVIDER` değişkenini kaldırın veya `local` olarak ayarlayın:

```env
CDN_PROVIDER=local
```

Sunucuyu yeniden başlatın. Yeni yüklemeler tekrar `server/uploads/`'a gider.
Remote'taki eski dosyalar etkilenmez.

---

## Güvenlik Notları

- Bucket'ı **hiçbir zaman** tam public write erişimiyle açmayın
- S3 / R2: IAM policy'yi yalnızca `PutObject`, `DeleteObject`, `ListBucket` ile sınırlayın
- MinIO: production'da `minioadmin`/`minioadmin` kimlik bilgilerini değiştirin
- Tüm endpoint'leri HTTPS üzerinden sunun
- `S3_SECRET_ACCESS_KEY` ve benzeri değerleri asla kaynak koduna commit etmeyin — `.env.example`'daki placeholder değerleri kullanın
