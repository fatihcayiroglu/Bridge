# Bridge 10/10 Production Checklist

Bu liste, projeyi sadece “çalışıyor” seviyesinden “güvenle yayınlanabilir” seviyeye taşımak için kullanılan kalite standardıdır.

## Kalite kapısı

- [ ] `npm run quality:gate` geçiyor.
- [ ] `npm run deploy:preflight` geçiyor.
- [ ] Root/server/electron audit sonucu high/critical açık yok.
- [ ] TypeScript, strict client ve Svelte check geçiyor.
- [ ] Client, server, mobile ve Electron build geçiyor.
- [ ] Server/Electron/mobile testleri geçiyor.
- [ ] Playwright smoke projesi CI'da çalışıyor.

## Operasyon

- [ ] Production `docker-compose.prod.yml` override ile çalışıyor.
- [ ] Container non-root çalışıyor.
- [ ] Bridge container `read_only: true` ile çalışıyor.
- [ ] `no-new-privileges` ve `cap_drop: ALL` aktif.
- [ ] `/api/health/live` liveness için kullanılıyor.
- [ ] `/api/health/ready` readiness için kullanılıyor.
- [ ] `/metrics` sadece Bearer `METRICS_SECRET` ile erişilebilir.
- [ ] Backup servisi planlı çalışıyor.
- [ ] Rollback runbook uygulanabilir durumda.

## Release

- [ ] Electron auto-update metadata dosyaları release artifact'larında var.
- [ ] Windows/macOS/Linux artifact'ları üretiliyor.
- [ ] macOS notarization secret'ları tanımlı.
- [ ] Windows signing secret'ları tanımlı.
- [ ] Release notları kullanıcıya anlaşılır.
- [ ] Rollback için önceki stabil tag hazır.

## Güvenlik

- [ ] JWT/refresh secret'ları farklı ve 32+ karakter.
- [ ] `AP_ENCRYPTION_KEY` 64 hex karakter.
- [ ] `FEDERATION_SECRET` güçlü ve benzersiz.
- [ ] `METRICS_SECRET` güçlü ve benzersiz.
- [ ] `.env` dosyası repoya eklenmiyor.
- [ ] CORS sadece gerçek origin'leri içeriyor.
- [ ] Upload limitleri production'a uygun.
- [ ] Rate limit değerleri beklenen trafiğe göre ayarlı.

## Ürün sonrası doğrulama

- [ ] Yeni kullanıcı giriş/kayıt akışı çalışıyor.
- [ ] Mesaj gönderme/alma çalışıyor.
- [ ] Dosya yükleme çalışıyor.
- [ ] Desktop güncelleme kontrolü çalışıyor.
- [ ] Hata logları ve metrikler gözlemlenebiliyor.
