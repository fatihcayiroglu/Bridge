# Bridge — PostgreSQL Geçiş Kılavuzu

SQLite'tan PostgreSQL'e geçiş üç adımda tamamlanır.
Mevcut SQLite veritabanına **dokunulmaz** — her şey güvenle geri alınabilir.

---

## Ön Koşullar

- PostgreSQL 14+ kurulu ve çalışıyor olmalı
- `pg` paketi zaten `package.json`'da mevcut

---

## Adım 1 — Veritabanı Oluştur

```bash
# PostgreSQL'e bağlan
psql -U postgres

# Veritabanı oluştur
CREATE DATABASE bridge;
CREATE USER bridge_user WITH PASSWORD 'güçlü_şifre_buraya';
GRANT ALL PRIVILEGES ON DATABASE bridge TO bridge_user;
\q
```

---

## Adım 2 — `.env` Dosyasını Güncelle

```env
# Mevcut SQLite satırını (varsa) kaldır, bunu ekle:
DATABASE_URL=postgresql://bridge_user:güçlü_şifre_buraya@localhost:5432/bridge

# Opsiyonel — SSL gerektiren cloud DB'ler için (Railway, Supabase, Neon):
DATABASE_SSL=true

# Opsiyonel — connection pool boyutu (varsayılan: 20)
PG_POOL_MAX=20
```

---

## Adım 3 — Mevcut Veriyi Taşı

### Önce kuru çalıştır (veri yazmadan kontrol):
```bash
DRY_RUN=1 DATABASE_URL=postgresql://... node server/db/migrate-to-postgres.js
```

### Gerçek migration:
```bash
node server/db/migrate-to-postgres.js
```

Örnek çıktı:
```
🌉 Bridge SQLite → PostgreSQL Migration
📂 Kaynak : /home/.../server/data/bridge.db
🐘 Hedef  : postgresql://bridge_user:***@localhost:5432/bridge

✅ PostgreSQL bağlantısı başarılı

📋 PostgreSQL schema kuruluyor...
✅ Schema hazır

📦 Tablolar aktarılıyor...

  ✅ users: 1248 eklendi, 0 atlandı, 0 hata
  ✅ servers: 87 eklendi, 0 atlandı, 0 hata
  ✅ messages: 94832 eklendi, 0 atlandı, 0 hata
  ...

--------------------------------------------------
✅ Migration tamamlandı!
   Toplam satır : 128493
   Hatalı satır : 0
   Süre         : 12.4s
```

### Sunucuyu başlat:
```bash
npm start
# Konsol: [DB] PostgreSQL modu aktif → postgresql://...
```

---

## Doğrulama

```bash
psql -U bridge_user -d bridge -c "SELECT COUNT(*) FROM messages;"
psql -U bridge_user -d bridge -c "SELECT COUNT(*) FROM users;"
```

---

## Sorun Giderme

| Hata | Çözüm |
|------|-------|
| `ECONNREFUSED` | PostgreSQL servisi çalışmıyor: `sudo systemctl start postgresql` |
| `password authentication failed` | `.env`'deki şifre ile DB kullanıcısı uyuşmuyor |
| `database "bridge" does not exist` | Adım 1'i tekrarla |
| `SSL SYSCALL error` | `DATABASE_SSL=true` ekle veya kaldır |
| Hatalı satırlar > 0 | Migration logunu incele; genellikle NULL constraint — idempotent olduğu için tekrar çalıştırılabilir |

---

## Cloud DB (Railway / Supabase / Neon)

Bu platformlar `DATABASE_URL`'i otomatik sağlar. Kopyala-yapıştır:

```env
DATABASE_URL=<platform'dan aldığın URL>
DATABASE_SSL=true
```

Migration komutu aynıdır.

---

## Geri Alma

`.env`'den `DATABASE_URL`'i kaldır veya yorum satırına al.
SQLite dosyası `server/data/bridge.db`'de sağlam duruyor.
Sunucu otomatik SQLite'a döner.
