# ADR-0002: Frontend Framework Seçimi — Svelte vs Vue

**Durum:** Taslak — Karar Bekleniyor  
**Tarih:** Mayıs 2026  
**Yazarlar:** Bridge Ekibi  
**İlgili:** ADR-0001 (DB Migration Strategy)

---

## Bağlam

Bridge'in istemci tarafı şu anda **Vanilla JS + esbuild** chunk sistemiyle çalışıyor (`chunk-boot`, `chunk-core`, `chunk-comms` vb.). Sprint 9-16 boyunca bu mimari iyi çalıştı; ancak bileşen yeniden kullanımı, state yönetimi ve geliştirici deneyimi açısından sınırlara dayanıyoruz. Belirli tetikleyiciler:

- **`client/js/core/`** altında 80+ JS/TS dosyası — bileşen sınırları yok, her şey global scope
- **`client/css/modules/`** altında 20 CSS dosyası manuel olarak yönetiliyor, scoped CSS yok
- TypeScript migration tamamlandıkça tip güvenliği iyileşiyor ama template/DOM tarafı hâlâ stringly-typed
- Test coverage client tarafında zayıf — `client/tests/` yalnızca 5 dosya, e2e ağırlıklı

Değerlendirilen seçenekler: **Svelte 5**, **Vue 3 (Composition API)**, **mevcut mimaride devam**.

---

## Karar Kriterleri

| Kriter | Ağırlık |
|--------|---------|
| Mevcut esbuild pipeline ile uyum | Yüksek |
| Bundle boyutu etkisi | Yüksek |
| TypeScript entegrasyonu | Yüksek |
| Kademeli (incremental) benimseme imkânı | Çok Yüksek |
| Ekip öğrenme eğrisi | Orta |
| Topluluk / ekosistem | Orta |
| SSR / SEO ihtiyacı | Düşük (SPA) |

---

## Seçenek Analizi

### Seçenek A: Svelte 5

**Avantajlar:**
- **Sıfır runtime:** Derleme zamanında düz JS üretir — mevcut chunk sistemiyle doğal uyum
- **Bundle boyutu:** Vue 3 + runtime'a kıyasla ~15-40 KB daha küçük (gzip sonrası)
- **Runes API (Svelte 5):** `$state`, `$derived`, `$effect` — mevcut `core/state.js` pattern'ına kavramsal olarak yakın
- **Scoped CSS built-in:** `<style>` bloğu otomatik scoped → `client/css/modules/` karmaşasını çözer
- **esbuild uyumu:** `esbuild-svelte` plugin ile doğrudan entegrasyon, Vite zorunlu değil

**Dezavantajlar:**
- Svelte 5 (Runes) hâlâ nispeten yeni — breaking changes riski
- `client/js/core/` dosyalarını `.svelte` bileşenlerine taşımak kapsamlı refactor gerektirir
- Topluluk Vue'ya kıyasla daha küçük; enterprise destek sınırlı
- SSR gerekirse SvelteKit bağımlılığı doğar (şu an gerekmiyor)

**esbuild entegrasyon örneği:**
```js
// scripts/build.js — ekleme
const { esbuildSvelte } = require('esbuild-svelte');

await esbuild.build({
  entryPoints: ['client/js/app.svelte'],
  bundle: true,
  plugins: [esbuildSvelte({ compilerOptions: { css: 'injected' } })],
  outfile: 'client/dist/js/chunk-boot.js',
});
```

---

### Seçenek B: Vue 3 (Composition API)

**Avantajlar:**
- **Kademeli benimseme:** `createApp` birden fazla kez çağrılabilir — sayfa başına izole Vue "ada" mümkün, mevcut Vanilla JS'e dokunulmaz
- **Ekosistem olgunluğu:** Pinia, VueRouter, Vue DevTools — production-grade tooling
- **TypeScript:** `<script setup lang="ts">` ile birinci sınıf destek, tip çıkarımı güçlü
- **Composition API:** Mevcut `core/state.js` `composable`'lara doğal dönüşür
- **Büyük topluluk:** Daha kolay işe alım, daha fazla kaynak

**Dezavantajlar:**
- **Runtime (~22 KB gzip):** Her sayfaya Vue core eklenir — `chunk-boot` büyür
- **Vite baskısı:** Vue ekosistemi Vite etrafında döner; mevcut esbuild pipeline'ı zamanla sürdürmek zorlaşabilir
- `<template>` syntax öğrenme maliyeti — mevcut ekip Vanilla JS deneyimli
- `global.bridgeIO` / `global.bridgeSocketUsers` antipattern'i Vue state içine taşımak dikkat gerektirir

**Kademeli entegrasyon örneği:**
```js
// Mevcut index.html — sadece yeni bileşenler için ada yaklaşımı
import { createApp } from 'vue';
import SettingsModal from './components/SettingsModal.vue';

// Mevcut Vanilla JS'e dokunmadan sadece settings modal'ını Vue ile değiştir
const settingsApp = createApp(SettingsModal);
settingsApp.mount('#settings-mount-point');
```

---

### Seçenek C: Mevcut Mimaride Devam (Vanilla JS + esbuild)

**Avantajlar:**
- Sıfır geçiş maliyeti
- TypeScript migration (Sprint 3-16) zaten yürüyor — tamamlandıktan sonra değerlendir
- En küçük bundle, en az bağımlılık

**Dezavantajlar:**
- Bileşen yeniden kullanımı hâlâ manuel (`innerHTML` pattern'ları, event delegation)
- CSS scoping yok — `client/css/modules/` büyümeye devam eder
- Büyük özellikler için test yazmak giderek zorlaşıyor

---

## Karşılaştırma Tablosu

| Kriter | Vanilla JS | Svelte 5 | Vue 3 |
|--------|-----------|----------|-------|
| Bundle artışı | 0 | ~0 (derleme zamanı) | +22 KB runtime |
| esbuild uyumu | ✅ Doğal | ✅ Plugin ile | ⚠️ Vite baskısı |
| Kademeli benimseme | ✅ Zaten öyle | ⚠️ Tam geçiş önerilir | ✅ Ada yaklaşımı |
| TypeScript | ✅ (Sprint 15 ile) | ✅ Built-in | ✅ Güçlü |
| Scoped CSS | ❌ Manuel | ✅ Otomatik | ✅ `<style scoped>` |
| Test kolaylığı | ⚠️ Zor | ✅ `@testing-library/svelte` | ✅ Vue Test Utils |
| Öğrenme eğrisi | — | Düşük | Orta |
| Ekosistem olgunluğu | — | Orta | Yüksek |

---

## Bridge'e Özgü Kısıtlar

1. **`global.bridgeIO` kaldırıldı** (CRITICAL_FIXES) → `req.app.get('io')` kullanılıyor. Herhangi bir framework Socket.IO bağlantısını `provide/inject` veya composable ile sarmalayabilir.

2. **Chunk sistemi korunmalı** — `chunk-boot`, `chunk-core` vb. yükleme sırası önemli. Svelte build-time çıktısı bu sıraya daha kolay uyar. Vue `createApp` çağrıları `chunk-boot` yüklendikten sonra yapılabilir.

3. **`client/css/modules/` (20 dosya)** zaten `style.css` entry point üzerinden esbuild ile bundle ediliyor. Svelte scoped CSS ile bu dosyaların büyük kısmı bileşenlere taşınabilir. Vue `<style scoped>` aynı sonucu verir ama ekstra build step gerektirir.

4. **TypeScript migration devam ediyor** — `tsconfig.session5.json` client strict typecheck için hazır. Her iki framework de bu config ile uyumlu.

5. **Mediasoup/WebRTC** (`chunk-webrtc.js`) — framework agnostic; mevcut haliyle bırakılabilir.

---

## Öneri

> **Vue 3 — Kademeli Ada Yaklaşımı**

**Gerekçe:** TypeScript migration (Sprint 3-16) hâlâ aktif. Tam framework geçişi için en az Sprint 18-19'u beklemek gerekir. Bu aşamada en düşük riskli strateji:

1. Yeni bileşenler `Vue 3 + Composition API` ile yazılır (`settings-modal`, `profile-page` gibi karmaşık UI'lar öncelikli)
2. Mevcut `client/js/core/` dosyalarına dokunulmaz
3. Vue devtools ve Pinia geçiş planlanır — ancak Pinia `core/state.js` tamamen migrate edilene kadar **eklenmez**
4. Sprint 18 sonunda değerlendirme: Svelte'e kıyasla geliştirici memnuniyeti ölçülür

**Svelte neden ikinci?** Kademeli benimseme daha zor ve esbuild-svelte plugin'i production'da daha az battle-tested. Svelte için tam geçiş kararı, mevcut `client/js/` refactor tamamlandıktan sonra yeniden değerlendirilmelidir.

---

## Reddedilen Alternatifler

- **React:** Bundle boyutu ve mevcut DOM manipulation pattern'larıyla uyumsuzluk
- **SvelteKit / Nuxt:** SSR gerektirmiyor, overkill
- **Lit / Web Components:** Ekosistem kısıtları, TypeScript DX zayıf

---

## Sonraki Adımlar (Karar kabul edilirse)

- [ ] Vue 3 proof-of-concept: `client/js/settings.js` → `SettingsModal.vue`
- [ ] `esbuild` + `@vitejs/plugin-vue` karşılaştırma benchmark'ı
- [ ] `client/tsconfig.session5.json`'a Vue tipler eklenmesi (`vue-tsc`)
- [ ] CSS Modules aktivasyon ADR'ı ile koordinasyon (bkz. esbuild config belgesi)

---

*Bu ADR, ADR-0001 (DB Migration Strategy) formatını takip eder ve `docs/` klasörüne eklenmelidir.*
