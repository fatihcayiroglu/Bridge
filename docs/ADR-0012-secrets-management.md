# ADR-0012 — Secrets Yönetimi: Vault/Secrets Manager Adapter

**Tarih:** 2026-06-03  
**Durum:** Kabul edildi (Sprint 112)  
**Sprint:** 112  
**Karar verenler:** Bridge geliştirme ekibi

---

## Bağlam

Sprint 108'de `AP_ENCRYPTION_KEY` için `process.env` bağımlılığı şu sorunları doğuruyordu:

1. **Kubernetes ortamında**: Sealed Secrets veya harici operator gerektiriyor; native Vault entegrasyonu yok.
2. **Denetim izi**: Hangi servis hangi secret'a erişti? `process.env`'de görünmüyor.
3. **Rotasyon**: Key rotasyonu için pod restart gerekiyor; Vault'ta TTL-tabanlı otomatik rotasyon mümkün.
4. **Çok-backend**: Self-host (env), küçük ekip (HashiCorp Vault), kurumsal (AWS Secrets Manager).

---

## Karar

`server/lib/vault.ts` adapter'ı üç backend'i destekler:

| Backend | `VAULT_BACKEND` değeri | Kullanım |
|---------|----------------------|---------|
| Ortam değişkeni | `env` (varsayılan) | Geliştirme, basit self-host |
| HashiCorp Vault | `hashicorp` | Kubernetes, production |
| AWS Secrets Manager | `aws` | AWS deployment |

### Fault Tolerance

Vault erişimi başarısız olursa **`process.env` fallback** devreye girer. Bu, Vault geçici olarak erişilemez durumda bile uygulamanın çalışmaya devam etmesini sağlar; log uyarısı gönderilir.

### Cache

Vault'a her istek için ağ çağrısı yapılmaz. 5 dakika TTL in-memory cache kullanılır. `getSecret('KEY', { override: true })` ile cache atlanabilir.

### Production Güvenlik

`validateRequiredSecrets(['AP_ENCRYPTION_KEY', 'JWT_SECRET', ...])` uygulama başlangıcında çağrılır. Eksik kritik sır varsa `NODE_ENV=production`'da `process.exit(1)` tetiklenir.

---

## Gelecek

- Sprint 118: Vault dynamic secrets (DB credential rotasyonu)
- Sprint 120: Vault audit log → Bridge audit log entegrasyonu

---

## İlgili Belgeler

- [server/lib/vault.ts](../server/lib/vault.ts)
- [server/lib/apKeyEncryption.ts](../server/lib/apKeyEncryption.ts)
- [docs/AP_ENCRYPTION_KEY_ROTATION_RUNBOOK.md](AP_ENCRYPTION_KEY_ROTATION_RUNBOOK.md)
