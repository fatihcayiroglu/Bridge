# Bridge — Hızlı Kurulum (PostgreSQL)

Tam referans: [README.md](./README.md) · Dağıtım zip'i: [DISTRIBUTION.md](./DISTRIBUTION.md)

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

## 2. Ortam dosyası

```bash
cp server/.env.example server/.env
```

`.env` içinde doldur:

```env
JWT_SECRET=<node -e "console.log(require('crypto').randomBytes(64).toString('hex'))">
REFRESH_SECRET=<aynı komutu tekrar çalıştır, farklı değer>
DATABASE_URL=postgresql://bridge_user:guvenli_sifre_buraya@localhost:5432/bridge
```

## 3. Kurulum, derleme ve başlatma

```bash
# Kök dizinde
npm run setup          # npm install + server install + client/server build

# veya adım adım:
npm install
cd server && npm install && cd ..
npm run build
npm start
```

İlk başlatmada PostgreSQL şeması otomatik oluşturulur (`initSchema`).

```bash
curl http://localhost:3001/api/health/ready
# {"status":"ok",...}
```

Geliştirme modu (hot reload):

```bash
npm run dev
```

## Docker ile (önerilen)

```bash
cp .env.docker .env
# JWT_SECRET, REFRESH_SECRET, POSTGRES_PASSWORD doldur
docker compose up -d --build
```

→ http://localhost:3001

## Sorun mu var?

| Hata | Çözüm |
|------|-------|
| `Production build eksik` | `npm run build` |
| `ECONNREFUSED` | `sudo systemctl start postgresql` |
| `password authentication failed` | `.env` şifresi ile psql uyuşmuyor |
| `DATABASE_URL tanımlı değil` | `server/.env` dosyasını kontrol et |
| `too many clients` | `PG_POOL_MAX=10` ekle |

## Oracle Cloud Free Tier

Detaylı rehber: **[ORACLE_CLOUD_SETUP.md](./ORACLE_CLOUD_SETUP.md)**
