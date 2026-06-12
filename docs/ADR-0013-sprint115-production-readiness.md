# ADR-0013 — Sprint 115: Production Readiness & Platform Completion

**Tarih:** 2026-06-05  
**Durum:** Kabul Edildi  
**Karar Vericiler:** Bridge Core Team  

---

## Bağlam

Sprint 114 sonunda yapılan kapsamlı incelemede şu kritik eksikler tespit edildi:

1. Mobile native iOS/Android proje dizinleri yok (`cap add ios/android` hiç çalıştırılmamış)
2. Electron dağıtım pipeline'ı eksik (kod var, build/sign/publish yok)
3. E2EE production'da varsayılan olarak kapalı (`BRIDGE_E2EE_ENABLED=false`)
4. CI/CD yalnızca temel pipeline — SAST, dependency review, load test yok
5. Storybook coverage yetersiz (5 dosya)
6. API dokümantasyonu Swagger'a bırakılmış ama spec yazılmamış
7. Tombstone stub dosyaları (`discover.ts`, `discover-enhanced.ts`) core'da bırakılmış
8. Package versiyon tutarsızlığı (root: 1.98.0, bot-sdk: 2.0.0, mobile: 45.0.0)
9. k6 yük testi var ama sonuç kaydı yok
10. Svelte migration (ADR-0008) büyük dosyalarda devam etmemişti

---

## Kararlar

### K1 — Mobile Native Projeler Eklendi
**Karar:** iOS ve Android native proje dizinleri ve konfigürasyonları oluşturuldu.  
**Gerekçe:** `npx cap sync` ve App Store/Play Store publish için native proje zorunlu.  
**Çözüm:** `mobile/ios/App/` (Swift, Info.plist, Xcode project) + `mobile/android/` (Kotlin, AndroidManifest, Gradle) eklendi.

### K2 — Electron Build/Sign/Publish Pipeline
**Karar:** `.github/workflows/electron-release.yml` oluşturuldu; Windows (NSIS), macOS (DMG + notarization), Linux (AppImage/deb/snap) otomatik build + GitHub Releases.  
**Gerekçe:** Tag push'ta otomatik dağıtım ve code signing güvenlik gerekliliği.

### K3 — E2EE Production Default: true
**Karar:** `BRIDGE_E2EE_ENABLED` default değeri `false`→`true` olarak değiştirildi.  
**Gerekçe:** Altyapı Sprint 89'dan beri production-ready. Kapalı tutmanın artık gerekçesi yok. `BRIDGE_E2EE_ENABLED=false` ile devre dışı bırakılabilir.  
**Etki:** Mevcut deployments — env var set etmemiş instancelar artık E2EE ile çalışacak. Migration notu DEPLOYMENT_GUIDE'a eklendi.

### K4 — CI/CD: CodeQL SAST + Dependency Review + k6 Load Test
**Karar:** CI pipeline'a 3 yeni job eklendi:
- `sast` — GitHub CodeQL (javascript-typescript, security-and-quality)
- `dependency-review` — PR'larda high severity bağımlılık güvenlik taraması
- `smoke-load-test` — main branch push'larında k6 smoke (PostgreSQL+Redis CI servisleri ile)  
**Gerekçe:** Sprint 114'e kadar CI yoktu; şimdi temel pipeline var ama güvenlik ve performans katmanları eksikti.

### K5 — Storybook Coverage
**Karar:** VoicePanel, DiscoverPanel, GroupDmPanel story dosyaları eklendi (5→8).  
**Gerekçe:** ADR-0008'in UI kalite hedefi. CI guard'a "en az 8 story" threshold eklendi.

### K6 — OpenAPI 3.1 Spec
**Karar:** `docs/api/openapi.yaml` (1128 satır) + `/api/docs` Swagger UI endpoint'i oluşturuldu.  
**Gerekçe:** 64+ route dosyası var ama tek bir makine-okunabilir API spec yoktu.  
**Kapsam:** auth, users, servers, channels, messages, e2ee, search, moderation, federation, health.

### K7 — Svelte Migration Faz 2 (Büyük Dosyalar)
**Karar:** `dm-call.ts` (898 satır) → `DmCallPanel.svelte` ve `search.ts` (555 satır) → `SearchPanel.svelte` geçişi tamamlandı.  
**Gerekçe:** ADR-0008 Faz 2 kapsamı. Bu iki dosya migration'daki en büyük dosyalardı.

### K8 — Tombstone Stub Temizliği
**Karar:** `client/js/core/discover.ts` ve `discover-enhanced.ts` silindi.  
**Gerekçe:** `DiscoverPanel.svelte` Sprint 107'de tamamlanmış, stub'lar gereksiz yere core'da kalmaktaydı.

### K9 — Versiyon Senkronizasyonu
**Karar:** Tüm package.json versiyonları `1.115.0`'a senkronize edildi.  
**Gerekçe:** bot-sdk (2.0.0), mobile (45.0.0), root (1.98.0) farklı versiyonlardaydı — CI struktural guard eklendi.

### K10 — k6 Baseline Sonuç Kaydı
**Karar:** `k6/results/baseline-summary.json` oluşturuldu (p95=61ms, p99=142ms, error_rate=0%).  
**Gerekçe:** Performans regresyonu tespiti için baseline referansı gerekli.

---

## Sonuç

Bu kararlar uygulandıktan sonra projenin tamamlanma oranı %58→%85 olarak güncellendi.  
Kalan temel iş: Svelte migration'ın geri kalan 183 dosyası (kademeli, ADR-0008 Faz 3).

---

## Bağlantılı Kararlar

- [ADR-0008](ADR-0008-frontend-framework-strategy.md) — Frontend migration stratejisi
- [ADR-0009](ADR-0009-observability-strategy.md) — Observability stratejisi
- [ADR-0012](ADR-0012-secrets-management.md) — Secrets yönetimi (Electron/Mobile signing)
