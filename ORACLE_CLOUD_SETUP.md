# Oracle Cloud Free Tier — Bridge Kurulum Rehberi

**ARM instance (4 vCPU / 24 GB RAM) · Ubuntu 22.04 · Ücretsiz**

---

## 1. Oracle Cloud Hesabı Açma

1. https://cloud.oracle.com/free adresine git
2. **"Start for free"** butonuna tıkla
3. Formu doldur:
   - E-posta adresi (gerçek, doğrulama gelecek)
   - Ev adresi (Türkiye seçilebilir)
   - **Kredi kartı zorunlu** ama çekim yapılmaz — sadece kimlik doğrulama
   - Home Region seç: **Germany Central (Frankfurt)** veya **UK South (London)** — Türkiye'ye en yakın, **değiştirilemez**, dikkatli seç
4. E-posta doğrulama linkine tıkla
5. Hesap aktif olana kadar 15-30 dk bekle (bazen birkaç saat sürer)

> **Not:** Oracle bazen Free Tier hesabı otomatik kapatır. "Always Free" kaynaklarını kullandığın sürece ücret gelmez ama kart bilgisi şart.

---

## 2. ARM Instance Oluşturma (Ampere A1)

### 2.1 Compute → Instances → Create Instance

1. Sol menü: **Compute → Instances → Create Instance**
2. **Name:** `bridge-server`
3. **Image:** Edit → Ubuntu → **Ubuntu 22.04** (ARM compatible) → seç
4. **Shape:** Edit → **Ampere → VM.Standard.A1.Flex**
   - OCPUs: **4**
   - Memory: **24 GB**
   - (Free Tier limiti: 4 OCPU + 24 GB toplam, tek instance'a verebilirsin)
5. **Networking:**
   - Create new VCN (veya mevcut)
   - **Assign a public IPv4 address: YES** ← kritik
6. **SSH Keys:**
   - "Generate a key pair for me" → **Private key'i indir** (`ssh-key-*.key`)
   - Sakla, kaybolursa sunucuya giremezsin
7. **Boot Volume:** 100 GB (ücretsiz limit 200 GB, tek instance)
8. **Create** → 2-3 dk bekle

### 2.2 Public IP'yi Not Al

Instance listesinde **Public IP address** sütununu not al: `xxx.xxx.xxx.xxx`

---

## 3. Firewall — Port Açma

Oracle'ın iki katman firewall'u var: Security List + iptables. İkisini de açman gerekir.

### 3.1 Security List (Oracle tarafı)

1. Instance detayına git → **Subnet** linkine tıkla
2. **Security Lists** → Default Security List
3. **Add Ingress Rules** — aşağıdakileri ekle:

| Source CIDR | Protocol | Port | Açıklama |
|-------------|----------|------|----------|
| 0.0.0.0/0 | TCP | 80 | HTTP |
| 0.0.0.0/0 | TCP | 443 | HTTPS |
| 0.0.0.0/0 | TCP | 3001 | Bridge (test için) |

### 3.2 iptables (Ubuntu tarafı)

SSH ile bağlandıktan sonra:

```bash
sudo iptables -I INPUT -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 3001 -j ACCEPT
sudo netfilter-persistent save
```

---

## 4. SSH ile Bağlanma

```bash
# İndirilen key'in izinlerini düzelt
chmod 600 ~/Downloads/ssh-key-*.key

# Bağlan (ubuntu kullanıcısı, Oracle Ubuntu default)
ssh -i ~/Downloads/ssh-key-*.key ubuntu@<PUBLIC_IP>
```

---

## 5. Sunucu Hazırlığı

```bash
# Sistem güncelle
sudo apt update && sudo apt upgrade -y

# Docker kur
curl -fsSL https://get.docker.com | sudo bash
sudo usermod -aG docker ubuntu
newgrp docker   # veya yeniden login

# Docker Compose v2 kontrolü
docker compose version
# Çıktı: Docker Compose version v2.x.x

# netfilter-persistent (iptables kuralları restart'ta kalsın)
sudo apt install -y netfilter-persistent iptables-persistent
```

---

## 6. Bridge'i Deploy Etme

### 6.1 Zip'i Sunucuya Aktar

Kendi bilgisayarından:
```bash
scp -i ~/Downloads/ssh-key-*.key bridge_work.zip ubuntu@<PUBLIC_IP>:~/
```

### 6.2 Kurulum

Sunucuda:
```bash
cd ~
unzip bridge_work.zip
cd bridge_work

# .env dosyası oluştur
cp server/.env.example server/.env

# Zorunlu değerleri düzenle
nano server/.env
```

`.env` içinde mutlaka değiştir:
```env
JWT_SECRET=<openssl rand -hex 64 çıktısı>
REFRESH_SECRET=<openssl rand -hex 64 çıktısı>
ALLOWED_ORIGINS=http://<PUBLIC_IP>:3001
```

```bash
# Başlat
docker compose up -d --build

# Logları takip et
docker compose logs -f bridge

# Health kontrolü
curl http://localhost:3001/api/health
```

### 6.3 İlk Açılışta Schema Otomatik Oluşur

`server/db/loader.ts` → `DATABASE_URL` varsa `postgres.ts` yüklenir → `initSchema()` tüm tabloları `IF NOT EXISTS` ile oluşturur. Manuel müdahale gerekmez.

---

## 7. Eski SQLite Verisi Varsa Migration

```bash
# Sadece eski kurulumdan taşıma gerekiyorsa:
docker compose exec bridge node server/dist/db/migrate-to-postgres.js

# Kuru çalıştırma (veri yazmadan kontrol):
docker compose exec bridge \
  sh -c "DRY_RUN=1 node server/dist/db/migrate-to-postgres.js"
```

---

## 8. Domain + HTTPS (Opsiyonel)

Domain varsa:

```bash
# Nginx + Certbot
sudo apt install -y nginx certbot python3-certbot-nginx

# Nginx reverse proxy config
sudo tee /etc/nginx/sites-available/bridge << 'EOF'
server {
    listen 80;
    server_name yourdomain.com;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400;
    }
}
EOF

sudo ln -s /etc/nginx/sites-available/bridge /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL
sudo certbot --nginx -d yourdomain.com

# .env güncelle
# ALLOWED_ORIGINS=https://yourdomain.com
```

Domain yoksa direkt `http://<PUBLIC_IP>:3001` ile erişirsin (HTTPS olmaz).

---

## Yararlı Komutlar

```bash
# Durum
docker compose ps

# Loglar
docker compose logs -f bridge
docker compose logs -f postgres

# Yeniden başlat
docker compose restart bridge

# Güncelleme (yeni zip geldiğinde)
docker compose down
unzip -o bridge_work.zip
docker compose up -d --build

# PostgreSQL'e direkt bağlan
docker compose exec postgres psql -U bridge -d bridge
```

---

## Free Tier Limitleri (2024)

| Kaynak | Limit |
|--------|-------|
| ARM Compute (A1) | 4 OCPU + 24 GB RAM toplam |
| Block Storage | 200 GB toplam |
| Outbound Data | 10 TB/ay |
| Object Storage | 20 GB |

Bridge + PostgreSQL + Redis için 4 vCPU / 24 GB fazlasıyla yeterli.
