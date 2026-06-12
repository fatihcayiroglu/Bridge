# ADR-0003: 4K Video Gönderme — Screen Capture + Chunked Upload

## Status
Accepted (Sprint 70)

## Context

DM araması sırasında veya bağımsız olarak yüksek çözünürlüklü video klip kaydedip karşı tarafa iletme ihtiyacı doğdu. Değerlendirilen yaklaşımlar:

1. **WebRTC data channel üzerinden gerçek zamanlı akış** — düşük gecikme, ancak 4K bitrate yönetimi karmaşık; alıcı tarafta buffer overflow riski yüksek.
2. **Sunucu taraflı transcode + depolama** — kalite korunur, ancak sunucu maliyeti ve gecikme kabul edilemez.
3. **Client-side MediaRecorder + chunked HTTP upload → `file:send` socket eventi** — mevcut upload altyapısını yeniden kullanır; büyük dosyalar için chunked upload güvenilirdir.

## Decision

`getDisplayMedia` ile ekran/kamera yakalama + `MediaRecorder` ile yerel kayıt yapılır. Kayıt tamamlandıktan sonra mevcut chunked upload endpoint'i üzerinden sunucuya gönderilir ve alıcıya `file:send` socket eventi tetiklenir.

Çözünürlük: `3840×2160` (4K UHD) ideal; `getUserMedia` veya `getDisplayMedia` cihaz kısıtı nedeniyle başarısız olursa `1920×1080` fallback otomatik devreye girer.

Maksimum kayıt süresi `_4K_MAX_DURATION_MS = 120_000` ms (2 dakika) olarak sabitlendi; aşılırsa kayıt otomatik durur ve upload başlar.

## Uygulama Detayları

| Bileşen | Dosya |
|---------|-------|
| Kayıt / upload mantığı | `client/js/core/dm-call.ts` |
| Public API | `DmCall.send4KVideo()` |
| İç state | `_currentRecorder`, `_4kTimer` (module-level) |
| Upload | `_upload4KFile(file)` → chunked POST |
| UI | `_show4KProgress()` / `_update4KProgress()` / `_hide4KProgress()` |
| Testler | `client/tests/dm-call-4k.test.ts` (15 test) |

## Consequences

**Olumlu:**
- Mevcut upload ve file:send altyapısı yeniden kullanıldı, yeni sunucu kodu gerekmedi.
- Cihaz desteği olmayan durumlarda graceful fallback var.
- Kayıt istemci tarafında gerçekleştiğinden sunucu transkode maliyeti sıfır.

**Olumsuz / Dikkat Edilecekler:**
- 4K dosya boyutu büyük olabilir (2 dakika ≈ 500 MB–2 GB codec'e göre); upload süresi ve bant genişliği kullanıcıya yük oluşturabilir.
- `getDisplayMedia` mobil tarayıcılarda desteklenmez; mobil istemcilerde buton gizlenmelidir.
- Chunked upload ortada kesilirse kısmi dosya sunucuda kalır; `cleanupUploads` job'ı bu artıkları 24 saat sonra temizler.
- Maksimum süre `_4K_MAX_DURATION_MS` sabit olarak kodlanmıştır; ileride sunucu tarafı yapılandırmaya taşınabilir.
