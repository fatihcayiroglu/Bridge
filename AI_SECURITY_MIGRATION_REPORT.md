# AI Security Migration Report

Bu turda önceki düzeltmelerin üzerine güvenlik açıkları ve kırıcı dependency yükseltmeleri ele alındı.

## Yapılan yükseltmeler

- `vitest` ve `@vitest/coverage-v8`: `^4.1.8`
- `@sveltejs/vite-plugin-svelte`: `^7.1.2`
- `vite`: `^8.0.16`
- `esbuild`: `^0.28.1`
- `svelte`: `^5.56.3`
- `svelte-check`: `^4.6.0`
- `@capacitor/*`: Capacitor 8 hattına taşındı.
- `@capawesome/capacitor-badge`: `^8.0.2`
- `@aparajita/capacitor-biometric-auth`: `^10.0.0`
- `multer`: `^2.1.1`
- `@types/multer`: `^2.1.0`
- Mobil Jest doğrulaması için eksik kök test bağımlılıkları eklendi: `jest-environment-jsdom`, `@babel/core`, `@babel/preset-env`, `babel-jest`.

## Kod/config düzeltmeleri

- `scripts/build.js`: Yeni esbuild sürümünde Safari 14 hedefi destructuring dönüşümünde hata verdiği için hedef `safari14.1` olarak güncellendi.
- `client/vitest.config.mts`: Yeni Svelte Vite plugin sürümünde geçersiz olan `hot` inline seçeneği kaldırıldı.
- `mobile/scripts/setup.js`: `capacitor-bridge.ts` artık otomatik olarak `capacitor-bridge.js` dosyasına derleniyor ve `mobile/www/js/` içine kopyalanıyor. Önceden native bridge dosyası eksik kalıyordu.
- `mobile/tests/capacitor-bridge.test.js`: Jest mock kurulumu sadeleştirildi; global `Capacitor`, `matchMedia` ve plugin mock setup’ı gerçek bridge testlerini çalıştıracak şekilde düzeltildi.
- `jest.mobile.config.js`: Mobil testlerin legacy Electron mock’larıyla çakışmasını önlemek için ignore pattern eklendi; `restoreMocks` kapatıldı.
- `mobile/package-lock.json`: Mobil paket ağacı için lock dosyası üretildi.

## Doğrulama

Aşağıdaki kontroller başarıyla geçti:

```bash
npm audit
cd server && npm audit
cd mobile && npm audit
npm run typecheck
npm run typecheck:strict-client
npm run typecheck:client-bridge5
npm run typecheck:svelte
npm run build
npm run mobile:build
cd server && npx jest tests/badges.test.ts tests/discover2.test.ts --runInBand --forceExit
npx jest --config jest.mobile.config.js --passWithNoTests --runInBand --forceExit
```

Sonuçlar:

- Root audit: 0 açık
- Server audit: 0 açık
- Mobile audit: 0 açık
- Svelte check: 0 hata, 0 uyarı
- Server hedef testleri: 19/19 geçti
- Mobile bridge testleri: 38/38 geçti
- Production build: başarılı
- Mobile www build: başarılı, `capacitor-bridge.js` mevcut

## Notlar

- `test:svelte` komutu projedeki birçok eski Jest tarzı client testini Vitest ile çalıştırmaya çalışıyor; bu test seti dependency migration’dan bağımsız olarak karışık Jest/Vitest yapısı nedeniyle ayrı bir test mimarisi temizliği gerektiriyor. Bu turda build, typecheck, Svelte check, server hedef testleri ve mobil bridge testleri doğrulandı.
- Server testleri kök `node_modules` üzerinden çalıştırıldığında `prom-client bulunamadı` uyarısı loglayabiliyor; server kendi bağımlılıklarıyla (`server/package.json`) kurulduğunda `prom-client` zaten dependency olarak tanımlı.
