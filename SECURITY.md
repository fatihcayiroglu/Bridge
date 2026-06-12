# Güvenlik Politikası

## Desteklenen Sürümler

| Sürüm    | Destek     | Son Güvenlik Yaması |
|----------|------------|---------------------|
| 1.121.x  | ✅ Aktif   | Sprint 121          |
| 1.120.x  | ⚠️ Eski    | Sprint 120 (güvenlik güncellemesi alır) |
| 1.119.x  | ❌ EOL     | Sprint 119          |
| 1.118.x  | ❌ EOL     | Sprint 118          |
| < 1.118  | ❌ EOL     | —                   |

Yalnızca en güncel iki minor sürüm güvenlik yamaları alır.

---

## Güvenlik Açığı Bildirimi

**Lütfen güvenlik açıklarını herkese açık GitHub issue olarak açmayın.**

### Tercih edilen yol: GitHub Private Vulnerability Reporting

1. Bu repo → **Security** → **Advisories** → **Report a vulnerability**
2. GitHub, bildirimi özel tutar ve ekibi otomatik bilgilendirir.

### Alternatif: E-posta

Self-host kurulumları için güvenlik bildirimleri sunucunuzun yöneticisine yapılmalıdır.

PGP şifreli iletişim için sunucu yöneticisi kendi `.well-known/security.asc` dosyasını yayınlamalıdır:

```
# Örnek: Kendi sunucunuz için
https://YOUR_DOMAIN/.well-known/security.asc
```

Self-host kurulumunuzda bu dosyayı oluşturmak için:
```bash
# PGP anahtarı oluştur
gpg --full-generate-key

# Public key'i dışa aktar
gpg --armor --export YOUR_EMAIL > /path/to/web/root/.well-known/security.asc

# Parmak izini kontrol et
gpg --fingerprint YOUR_EMAIL
```

### Bildirimde bulunması gerekenler

- **Etkilenen bileşen:** sunucu / istemci / federasyon / bot-sdk / eklenti
- **Güvenlik açığı türü:** RCE / XSS / SQLi / IDOR / DoS / bilgi ifşası / diğer
- **CVSS puanı (varsa):** https://www.first.org/cvss/calculator/3.1
- **Tekrar üretme adımları:** ortam, istek/yük, beklenen ve gerçek davranış
- **Kavram kanıtı (PoC):** varsa — ekipte güvenli ortamda incelenir
- **Etki değerlendirmesi:** hangi veriler veya kullanıcılar etkileniyor?

---

## Yanıt Süreci

| Aşama | Hedef Süre |
|-------|-----------|
| İlk onay | 48 saat |
| Triage & sınıflandırma | 5 iş günü |
| Yama planı iletişimi | 10 iş günü |
| Kritik yama yayını | 7 gün (kritik) / 30 gün (yüksek) |
| CVE başvurusu | Yamadan sonra (gerekirse) |

Bildirimi yapan kişi, yama yayınlanana kadar gizliliği korumayı taahhüt ederse:
- Kamuya açıklama koordinasyonu birlikte yapılır
- CHANGELOG ve advisory'de teşekkür edilir (talep üzerine)

---

## Kapsam

### Kapsam **içinde**
- `server/` — API, kimlik doğrulama, socket, middleware
- `client/` — XSS, istemci tarafı veri sızıntısı
- `bot-sdk/` — token güvenliği, injection
- `plugins/` — eklenti yalıtımı bypass
- Federasyon (ActivityPub) — sahte mesaj, kimlik sahtekarlığı
- Şifreleme (E2EE, AP key) — protokol zayıflıkları

### Kapsam **dışında**
- Self-host kurulumundaki yanlış yapılandırma (senin sorumluluğun)
- Üçüncü taraf bağımlılıklar (doğrudan upstream'e bildir + bizi bilgilendir)
- Sosyal mühendislik / phishing
- Rate limiting bypass (kendi sunucunuzda istenen bir özellik)
- Fiziksel güvenlik

---

## Bağımlılık Güvenliği

- **Dependabot** haftalık npm + aylık Docker güncellemesi önerir (`.github/dependabot.yml`)
- **CI** `npm audit --audit-level=high --production` çalıştırır (her PR'da)
- **Yerel kontrol:** `cd server && npm run audit:check`
- **SBOM:** `npm sbom --sbom-format cyclonedx > sbom.json` (Node.js 20+)

---

## Self-Host Güvenlik Kontrol Listesi

### Zorunlu

- [ ] `JWT_SECRET` ve `REFRESH_SECRET` en az 64 byte rastgele üret:
  ```bash
  openssl rand -hex 64
  ```
- [ ] `AP_ENCRYPTION_KEY` üret ve güvenli yerde sakla (key kaybı = federation özel anahtarları kurtarılamaz)
- [ ] `ADMIN_SETUP_SECRET` kurulumdan sonra değiştir veya `DISABLE_REGISTRATION=true` yap
- [ ] Production'da `NODE_ENV=production` set et
- [ ] HTTPS kullan (TLS 1.2+); HTTP'yi 301 ile yönlendir
- [ ] `DATABASE_SSL=true` (managed PostgreSQL kullanıyorsan)
- [ ] Redis şifreli bağlantı (`rediss://`) veya private ağda

### Güvenlik Bildirimi Altyapısı (self-host için)

- [ ] Yöneticiye ait PGP anahtarı oluştur (`gpg --full-generate-key`)
- [ ] Public key'i `/.well-known/security.asc` olarak web sunucusuna ekle
- [ ] `/.well-known/security.txt` dosyası oluştur:
  ```
  Contact: mailto:admin@YOUR_DOMAIN
  Encryption: https://YOUR_DOMAIN/.well-known/security.asc
  Preferred-Languages: tr, en
  ```

### Önerilen

- [ ] `METRICS_SECRET` set et (Prometheus `/metrics` herkese açık olmasın)
- [ ] `TRUSTED_PROXY_COUNT` veya `TRUSTED_PROXIES` doğru ayarla (IP spoofing önleme)
- [ ] MediaSoup için `MEDIASOUP_ANNOUNCED_IP` doğru public IP (WebRTC leak önleme)
- [ ] `server/uploads/` dizinini reverse proxy ile doğrudan erişime kapat; CDN üzerinden sun
- [ ] `IP_REPUTATION_ENABLED=true` + `ABUSEIPDB_KEY` (spam/abuse koruması)
- [ ] Dosya yükleme boyutu limitini reverse proxy seviyesinde de uygula
- [ ] `k8s/secret.yaml` yerine Sealed Secrets veya Vault kullan

### Güvenlik Duvarı

MediaSoup UDP portları (`MEDIASOUP_RTC_MIN_PORT`-`MEDIASOUP_RTC_MAX_PORT`, varsayılan 40000-49999)
yalnızca gerekli istemcilere açık olmalı. TCP 3001 (API) ve TCP 9090 (metrics) dışa kapalı tutulabilir.

---

## Güvenlik Özellikleri (Referans)

| Özellik | Durum | Detay |
|---------|-------|-------|
| JWT + Refresh rotation | ✅ | `server/middleware/auth.ts` |
| WebAuthn / Passkey | ✅ | `ADR-0005` |
| E2E Şifreleme (DM) | ✅ | `server/lib/e2e*.ts` |
| ActivityPub per-peer RSA | ✅ | `ADR-0006` |
| CSRF koruması | ✅ | Double-submit cookie |
| SSRF koruması | ✅ | `server/lib/ssrfGuard.ts` |
| IP kara liste | ✅ | `server/middleware/ipReputation.ts` |
| Rate limiting | ✅ | `ADR-0007`, `server/middleware/rateLimit.ts` |
| Sentry hata izleme | ✅ | `server/lib/sentry.ts` |
| Content Security Policy | ✅ | `server/middleware/csp.ts` |
| npm audit (CI) | ✅ | `.github/workflows/ci.yml` |

---

## CVE Geçmişi

Henüz kamuoyuna açıklanmış CVE bulunmamaktadır.
