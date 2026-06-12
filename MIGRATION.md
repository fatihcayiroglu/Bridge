# Bridge — Migration Rehberi

> **Sprint 50 güncellemesi:** Bu dosya sprint50'ye taşındı. Aşağıdaki sprint28
> notları tarihsel referans için korunmaktadır. Güncel deployment için bkz.
> [DEPLOYMENT_GUIDE.md](./DEPLOYMENT_GUIDE.md).

---

## Sprint 50 — TypeScript Tam Geçiş Notları

Sprint 50 ile tüm client kodu TypeScript'e taşındı. Eğer custom fork'unuz varsa:

1. `client/js/core/*.js` dosyalarının silindiğini ve `.ts` karşılıklarının geldiğini
   unutmayın — `scripts/build.js` entry point listesi güncellendi.
2. `tsconfig.json`'daki `strict: true` artık tüm server kodu için aktif.
3. `server/db/postgres/collection.ts` `@deprecated` işaretlidir — `pgCollection.ts`
   kullanın.

## Sprint 50 — Güvenlik Migration Notları

- `POSTGRES_PASSWORD` artık varsayılan değer taşımıyor. `.env` dosyasını güncelleyin.
- `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` varsayılan `minioadmin` değeri kaldırıldı.
  `.env` dosyasına güvenli değerler ekleyin.
- Egress firewall kurulumu için bkz. `DEPLOYMENT_GUIDE.md`.

---

## Sprint 28 — Tarihsel Notlar

Bu dosya, sprint28 klasöründeki 5 çıktının projeye nasıl entegre edileceğini açıklar.

> **Sprint 28 düzeltme notu:** Orijinal çıktılarda iki blocker tespit edildi ve bu
> pakette giderildi:
> 1. `mediasoup.ts` — `import sfuRegistry from` → `import * as sfuRegistry from`
>    ve `import turnConfig from` → `import { getIceServers, getIceTransportPolicy } from`
>    (named-export uyumsuzluğu; `tsc --noEmit` hata veriyordu)
> 2. `stage-socket-extra.test.js` — `stageRooms` zaten `stage.ts`'de export ediliyor,
>    `createMockDb` zaten `mockDb.js`'de mevcut; ek işlem gerekmez.

---

## 1. Stage socket testleri (stage-socket-extra.test.js)

**Hedef konum:**
```
server/tests/stage-socket-extra.test.js
```

**Yapılacaklar:**
- Dosya bu pakette `server/tests/` altına kopyalandı.
- `stageRooms` mevcut `stage.ts`'de zaten export ediliyor (`export { registerStageHandlers, stageRooms }`).
- `createMockDb` mevcut `mockDb.js`'de zaten mevcut.
- Çalıştır:
  ```bash
  cd server && npx jest stage-socket-extra --verbose
  ```

**Kapsanan yeni test senaryoları:** 19 test
- `stage:speaking` — 6 senaryo (VAD, mute guard, listener guard, state)
- `stage:setTopic` — 7 senaryo (host kontrolü, karakter limiti, null guard, state)
- `stage:setLive`  — 8 senaryo + 1 entegrasyon (topic+live kombine)

---

## 2. channel-perms-modal split (4 modül)

**Mevcut dosya:**
```
client/js/core/channel-perms-modal.ts   ← bu dosyayı sil (ya da yedekle)
```

**Yeni dosyalar ve hedef konumları:**
```
client/js/core/channel-perms/modal-state.js        ← state, matrix, cyclePerm
client/js/core/channel-perms/modal-actions.js       ← toolbar actions, user search
client/js/core/channel-perms/modal-audit-sync.js    ← audit log, bulk sync, export/import
client/js/core/channel-perms/modal-core.js          ← modal açma, inheritance, kaydet, socket
```

Bu dosyalar bu pakette `client/js/core/channel-perms/` altına yerleştirildi.

**index.html yükleme sırası** (mevcut `channel-perms-modal` script tag'ini bu 4 tag ile değiştir):
```html
<!-- Veri sabitleri önce yüklenmeli -->
<script src="/js/core/channel-perms-data.js"></script>

<!-- Modüller sırayla -->
<script src="/js/core/channel-perms/modal-state.js"></script>
<script src="/js/core/channel-perms/modal-actions.js"></script>
<script src="/js/core/channel-perms/modal-audit-sync.js"></script>
<script src="/js/core/channel-perms/modal-core.js"></script>
```

**channel-perms-data.js** zaten mevcutsa dokunma.
Yoksa `PERM_GROUPS`, `ALL_PERMS`, `PERM_TEMPLATES` sabitlerini oraya taşı —
bunlar artık hiçbir modal modülünün içinde olmamalı.

**Public API değişmedi** — `openChannelPermsModal`, `saveChannelPerms`,
`cyclePerm`, `chpermsTab` vs. hepsi `window.*` üzerinden erişilebilir,
çağıran kodlarda değişiklik gerekmez.

**Dosya boyutu özeti:**
| Eski | Yeni |
|---|---|
| channel-perms-modal.ts — ~71 000 satır | modal-state.js       ~219 satır |
|                                         | modal-actions.js     ~268 satır |
|                                         | modal-audit-sync.js  ~430 satır |
|                                         | modal-core.js        ~500 satır |

---

## 3. mediasoup.ts — TypeScript dönüşümü (import hatası düzeltildi)

**Hedef konum:**
```
server/socket/handlers/mediasoup.ts   ← mevcut dosyanın üzerine yaz
```

**Ne değişti (sprint 28 orijinaline ek düzeltmeler):**
- `import sfuRegistry from` → `import * as sfuRegistry from` (named-export uyumu)
- `import turnConfig from` → `import { getIceServers, getIceTransportPolicy } from`
- İlgili kullanım yerleri `turnConfig.getIceServers(...)` → `getIceServers(...)` olarak güncellendi

**Diğer değişiklikler (sprint 28 özgün):**
- `require('mediasoup')` → `await import('mediasoup')` (dynamic import, tip güvenli)
- Tüm `any` parametreler tiplendirildi: `SfuRoom`, `SfuPeer`, `BridgeUser`, `BridgeSocket`
- `MediasoupWorker / Router / Transport / Producer / Consumer` interface'leri eklendi
- `e.message` → `(e as Error).message` (strict catch typing)
- `socket.currentVoiceChannel` için `BridgeSocket extends Socket` arayüzü
- `_cleanupPeer` parametreleri `string | undefined` olarak düzeltildi
- `isSFUReady` arrow function export olarak tiplendirildi
- Prod uyarısı: `MEDIASOUP_ANNOUNCED_IP` eksikse `production` ortamında konsola uyarı yazar

**Derleme testi:**
```bash
cd server && npx tsc --noEmit
```
Hata yoksa geçiş tamamdır.

---

## Genel Kontrol Listesi

```
[x] server/socket/handlers/mediasoup.ts — import uyumsuzluğu giderildi
[x] server/tests/stage-socket-extra.test.js kopyalandı
[x] client/js/core/channel-perms/ klasörü oluşturuldu, 4 modül yerleştirildi

[ ] index.html script sırası güncellendi (manuel adım)
[ ] channel-perms-modal.ts yedeklendi/silindi (manuel adım)
[ ] Manuel test: kanal izin modalı açılıyor, kayıt çalışıyor
[ ] npx tsc --noEmit → hata yok
[ ] .env'de MEDIASOUP_ANNOUNCED_IP tanımlı (prod)
[ ] cd server && npx jest stage-socket-extra → 19 test geçti
[ ] npx jest --testPathPattern=sfu → mevcut SFU testleri geçti
```

---

## Sonraki Sprint İçin Öneriler

1. **modal-state.js → TypeScript** — `cyclePerm`, `_chpermsBuildMatrix` için prop
   tipleri eklemek kolay bir adım; client TS geçişinde erken kazanım sağlar.

2. **SFU entegrasyon testleri** — `mediasoup.ts` için mock router/transport
   kullanarak `sfu:join → sfu:produce → sfu:consume` happy path testi yazılabilir.

3. **PERM_GROUPS → ortak paket** — `channel-perms-data.js` hem client hem de
   server'da kullanılıyorsa `packages/shared-constants` altına taşımak
   mono-repo yapısına uygun olur.

4. **modal-core.js refactor** — `openChannelPermsModal` ~150 satırla tek işlev için
   büyük; veri yükleme ve DOM oluşturma ayrı fonksiyonlara bölünebilir.
