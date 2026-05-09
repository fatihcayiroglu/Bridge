# Bridge — Hızlı Kurulum (PostgreSQL)

## 1. PostgreSQL kullanıcısı ve veritabanı oluştur

```bash
sudo -u postgres psql
```

```sql
CREATE USER bridge_user WITH PASSWORD 'guvenli_sifre_buraya';
CREATE DATABASE bridge OWNER bridge_user;
GRANT ALL PRIVILEGES ON DATABASE bridge TO bridge_user;
\q
```

## 2. .env dosyasını hazırla

```bash
cd server
cp .env.example .env
```

`.env` dosyasında şunları doldur:

```env
JWT_SECRET=<node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
REFRESH_SECRET=<yukardaki komutu tekrar çalıştır, farklı bir değer>
DATABASE_URL=postgresql://bridge_user:guvenli_sifre_buraya@localhost:5432/bridge
```

## 3. Bağımlılıkları yükle ve başlat

```bash
npm install --omit=dev
npm start
```

İlk başlatmada tüm tablolar otomatik oluşturulur. Konsolda şunu görmelisin:

```
[DB] PostgreSQL -> postgresql://bridge_user:***@localhost:5432/bridge
Bridge server started on port 3001
```

## 4. Doğrula

```bash
curl http://localhost:3001/api/health/ready
# {"status":"ok","db":"postgresql"}
```

---

## Docker ile (alternatif)

```bash
cp .env.docker .env
# .env içinde JWT_SECRET ve REFRESH_SECRET doldur
docker compose up -d
```

---

## Sorun mu var?

| Hata | Çözüm |
|------|-------|
| `ECONNREFUSED` | `sudo systemctl start postgresql` |
| `password authentication failed` | .env'deki şifre ile psql şifresi uyuşmuyor |
| `DATABASE_URL tanımlı değil` | .env dosyası server/ klasöründe mi? |
| `too many clients` | `PG_POOL_MAX=10` ekle |

---

## Oracle Cloud Free Tier (VPS Kurulumu)

Detaylı rehber için: **[ORACLE_CLOUD_SETUP.md](./ORACLE_CLOUD_SETUP.md)**

Kısa özet:
1. https://cloud.oracle.com/free → hesap aç
2. Compute → Instances → **VM.Standard.A1.Flex** (4 OCPU / 24 GB) + Ubuntu 22.04
3. Security List'te 80, 443, 3001 portlarını aç
4. SSH ile bağlan → `scp` ile zip aktar → `docker compose up -d --build`

