# ADR-0007: Rate Limit Stratejisi — Sliding Window + Dual-Key

## Status
Accepted (Sprint 41, updated Sprint 107)

## Bağlam

Bridge'in rate limit sistemi Sprint 41'de büyük ölçüde yeniden yazıldı. Bu ADR tasarım kararlarını ve değerlendirilen alternatifleri belgeler.

## Karar

**Sliding-window** algoritması, Redis-backed store ile uygulandı.

### Neden Token Bucket değil?

Token bucket burst'e izin verir. Bridge gibi bir mesajlaşma platformunda 1 saniyede 30 mesaj göndermek (burst), ardından 59 saniye beklemek istemiyoruz. Sliding window daha tutarlı bir kullanıcı deneyimi sağlar.

### Neden Fixed Window değil?

Fixed window boundary attack'a açık: pencere sıfırlanmadan hemen önce + hemen sonra çift kota kullanılabilir. Sliding window bu açığı kapatır.

### IP+User Dual-Key

Her istek iki anahtarla kontrol edilir:
- `ip:<ip>:<category>` — kimlik doğrulanmamış saldırılara karşı
- `user:<userId>:<category>` — kullanıcı bazlı kota (VPN/proxy bypass'ı önler)

İkisinden biri dolunca 429 döner. Sprint 41'de tamamlandı.

### Redis Fallback

Redis yoksa in-memory sliding window çalışır. Multi-instance deploy'da in-memory yeterli değil; bu durumda `REDIS_URL` zorunludur (rateLimit.ts uyarı log'lar).

## Sonuçlar

- 25+ kategori, ortam değişkenleriyle override edilebilir
- İhlal sayısı eşiği aşılınca otomatik IP ban (`ipBan.ts` entegrasyonu)
- Socket rate limit ayrı: `socketRateLimit.ts` (Sprint 104/105)
