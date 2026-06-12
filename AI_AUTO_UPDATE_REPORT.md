# AI_AUTO_UPDATE_REPORT

Bu turda Bridge Desktop için Discord benzeri otomatik güncelleme sistemi kuruldu.

## Eklenenler

- `electron/updater.ts`
  - Startup sonrası otomatik güncelleme kontrolü.
  - 30 dakikalık periyodik kontrol.
  - Arka planda otomatik indirme.
  - `checking`, `available`, `downloading`, `downloaded`, `error` durum makinesi.
  - İndirme tamamlanınca native bildirim.
  - `updater:getStatus`, `updater:check`, `updater:install` IPC kanalları.

- `electron/preload.ts`
  - Renderer'a güvenli `window.bridgeUpdater` API'si açıldı.

- `client/js/core/desktop-updater.ts`
  - Uygulama içinde Discord benzeri küçük güncelleme paneli eklendi.
  - İndirme progress bar'ı ve “Yeniden başlat ve kur” düğmesi eklendi.

- `electron/main.ts`
  - Startup updater kurulumu eklendi.
  - Menü ve tray üzerinden manuel güncelleme kontrolü eklendi.
  - Paketli Electron içinde server başlatma yolu daha güvenli/gerçekçi hale getirildi.

- `electron/package.json`
  - Electron entry `dist/main.js` olarak düzeltildi.
  - `compile`, `dist:win`, `dist:mac`, `dist:linux` scriptleri düzeltildi.
  - Electron paketleme output'u `release/` klasörüne taşındı; TS `dist/` çıktısıyla çakışması engellendi.
  - Electron bağımlılıkları audit temiz olacak şekilde güncellendi.
  - electron-builder v26 şemasına uyum için Windows imzalama ayarları `win.signtoolOptions` altına taşındı.

- `server/tsconfig.build.json`
  - Kullanılmayan legacy doküman rotaları production build dışına alındı; release workflow server build aşamasında takılmıyor.

- `.github/workflows/electron-release.yml`
  - Platform bazlı build scriptleri düzeltildi.
  - Update metadata dosyaları `electron/release/latest*.yml` yolundan release'e eklenecek şekilde güncellendi.

- `docs/DESKTOP_AUTO_UPDATE.md`
  - Release, test ve ortam değişkenleri dokümante edildi.

## Doğrulama

Çalıştırılan kontroller:

```bash
npm audit --audit-level=high
cd server && npm audit --audit-level=high
cd electron && npm audit --audit-level=high
npm run typecheck
npm run typecheck:svelte
npm run build
cd server && npm run build
cd electron && npm run compile
cd electron && npm test -- --runInBand --forceExit
cd electron && npx electron-builder --dir --linux --publish never
cd server && npx jest tests/badges.test.ts tests/discover2.test.ts --runInBand --forceExit
```

Sonuçlar:

- Root audit: 0 açık
- Server audit: 0 açık
- Electron audit: 0 açık
- TypeScript typecheck: geçti
- Svelte check: 0 hata, 0 uyarı
- Production build: geçti
- Server build: geçti
- Electron compile: geçti
- Electron tests: 39/39 geçti
- Electron builder config: schema aşamasını geçti, paketleme aşamasında sandbox DNS problemi (`getaddrinfo EAI_AGAIN github.com`) yüzünden tam dry-run tamamlanamadı.
- Server hedef testleri: 19/19 geçti
