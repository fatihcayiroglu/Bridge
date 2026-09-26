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

### Fault Tolerance ve authority boundary

Production'da external backend (`hashicorp`/`aws`) seçildiğinde managed secret'lar için **fail-closed** davranılır. `process.env` fallback yalnız operatör açıkça `VAULT_ALLOW_ENV_FALLBACK=true` verdiğinde devreye girer. Development/test ortamında yerel çalışma kolaylığı için fallback varsayılan olarak açıktır.

### Cache

Vault'a her istek için ağ çağrısı yapılmaz. 5 dakika TTL in-memory cache kullanılır. `getSecret('KEY', { override: true })` ile cache atlanabilir.

### Production Güvenlik

`server/index.ts`, runtime graph'ini import etmeden önce `hydrateRuntimeSecrets()` çağırır. Böylece `JWT_SECRET`, `REFRESH_SECRET`, `DATABASE_URL`, `REDIS_URL`, `AP_ENCRYPTION_KEY`, `FEDERATION_SECRET` ve `METRICS_SECRET` varsayılan olarak external authority'den `process.env`'e hydrate edilir; ardından `lib/env.ts` normal production doğrulamasını fail-fast uygular. Liste `VAULT_MANAGED_SECRETS` ile açıkça değiştirilebilir.

Bu sıra kritiktir: runtime modülleri sırları import-time'da okuyabildiği için Vault hydration **env doğrulamasından ve production runtime importundan önce** tamamlanır. External backend'de bulunmayan managed bir sır, fallback açık değilse stale local env değerini kullanamaz.

---

## Gelecek

- Sprint 118: Vault dynamic secrets (DB credential rotasyonu)
- Sprint 120: Vault audit log → Bridge audit log entegrasyonu

---

## İlgili Belgeler

- [server/lib/vault.ts](../server/lib/vault.ts)
- [server/lib/apKeyEncryption.ts](../server/lib/apKeyEncryption.ts)
- [docs/AP_ENCRYPTION_KEY_ROTATION_RUNBOOK.md](AP_ENCRYPTION_KEY_ROTATION_RUNBOOK.md)
