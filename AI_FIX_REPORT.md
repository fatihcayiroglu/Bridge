# AI Fix Report

Bu paket üzerinde yapılan ana düzeltmeler:

## Düzeltilen hatalar

- Svelte 5 uyumluluğu için `client/js/core/*.svelte` içindeki eski `<slot />` kullanımları `children` snippet render yapısına taşındı.
- `FocusTrap.svelte` bileşeninde eksik `children` prop'u eklendi; `svelte-check` hatası giderildi.
- `client/js/core/i18n/index.ts` içindeki dinamik locale import yapısı açık `LOCALE_LOADERS` haritasına çevrildi; build sırasında oluşan boş glob uyarısı temizlendi.
- `OnboardingWizard`, `ChannelPermsModal`, `CommandPalettePanel`, `SettingsModal`, `ServerSettingsModal`, `GroupDmPanel`, `BotMarketplace`, `MediaTab`, `WebhookTab`, `AuditLogTab`, `DmCallPanel`, `SearchPanel`, `VoicePanel` ve `DiscoverPanel` içinde Svelte/a11y uyarıları giderildi.
- `server/routes/badges.ts` içinde mock/eksik DB koleksiyonu durumunda `undefined.find` hatasına düşen otomatik rozet kontrolü güvenli hale getirildi.
- `server/middleware/auth.ts` içinde admin yetkisi için gerekli `role` ve `flags` claim'leri JWT içine eklendi; admin rozet/keşif işlemlerindeki 403 hatası giderildi.
- `server/routes/discover.ts` ve `server/app/setupRoutes.ts` içinde `/api/admin/discover/feature` yolu eklendi; mevcut `/api/discover/admin/feature` yolu da korunuyor.
- `server/tests/helpers/setup.ts` eklendi; kırık test importları ve mock DB update dönüş değerinden kaynaklı test hataları düzeltildi.
- `server/lib/telemetry.ts` ve `server/lib/redisAdapter.ts` içinde tekrar tekrar signal listener eklenmesinden doğan `MaxListenersExceededWarning` engellendi.
- `server/routes/channelPerms/helpers.ts` içinde `express-rate-limit` IPv6 key generator uyarısı `ipKeyGenerator` ile düzeltildi.
- Projeye root `.gitignore` eklendi.

## Doğrulama

Aşağıdaki kontroller çalıştırıldı ve geçti:

```bash
npm run typecheck
npm run typecheck:strict-client
npm run typecheck:client-bridge5
npm run typecheck:svelte
npm run build
cd server && npx jest tests/badges.test.ts tests/discover2.test.ts --runInBand --forceExit
```

Sonuçlar:

- TypeScript typecheck: geçti
- Strict client typecheck: geçti
- Bridge5 client typecheck: geçti
- Svelte check: 0 hata, 0 uyarı
- Production build: geçti
- Seçili regresyon testleri: 19/19 geçti

## Kalan notlar

- `npm audit` halen 10 bulgu raporluyor: 6 moderate, 2 high, 2 critical. Bu bulguların önerilen fix'leri `@capacitor/cli`, `@sveltejs/vite-plugin-svelte`, `vitest`, `@vitest/coverage-v8`, `esbuild` gibi paketlerde semver-major yükseltme istiyor. Kırıcı migration riski olduğu için bu pakette otomatik major upgrade uygulanmadı; ayrı bir dependency migration branch'i açılması önerilir.
- Tam `npm test` çalıştırması ortam/tool zaman sınırına takıldı; ancak hedeflenen kırık dosyalar (`badges`, `discover2`) düzeltilip tekrar geçirildi.


## Security Migration Addendum

Dependency migration tamamlandı. Ayrıntılar için `AI_SECURITY_MIGRATION_REPORT.md` dosyasına bakın. Özet: root/server/mobile `npm audit` 0 açık, production build başarılı, mobile bridge build/test düzeltildi, server hedef testleri ve mobile bridge testleri geçti.
