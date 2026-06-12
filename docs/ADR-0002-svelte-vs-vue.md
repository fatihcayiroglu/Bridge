# ADR-0002: Frontend Framework Seçimi — Svelte vs Vue

**Durum:** ✅ KABUL EDİLDİ  
**Tarih:** Mayıs 2026  
**Yazarlar:** Bridge Ekibi  
**İlgili:** ADR-0001 (DB Migration Strategy)

---

## Karar

**Svelte 5 — Kademeli Ada Yaklaşımı (Island Strategy)**

Önceki taslakta Vue 3 önerilmişti. Sprint 38 değerlendirmesinden sonra karar **Svelte 5** lehine güncellendi. Aşağıdaki bölümler gerekçeyi ve migration planını açıklar.

---

## Bağlam

Bridge'in istemci tarafı **Vanilla JS + esbuild** chunk sistemiyle çalışıyor (`chunk-boot`, `chunk-core`, `chunk-comms` vb.). Sprint 38 itibarıyla:

- `client/js/core/` altında 80+ JS/TS dosyası — bileşen sınırı yok
- `client/css/modules/` altında 20 CSS dosyası manuel yönetiliyor, scoped CSS yok
- TypeScript migration tamamlandı (Sprint 26 strict:true base)
- Client test coverage zayıf — 5 dosya, e2e ağırlıklı
- `settings-modal.ts` (726 satır), `voice.js` (707 satır), `bot-marketplace.js` (50KB) bölünmeyi bekliyor

---

## Neden Vue Değil — Neden Svelte

Önceki taslak "TypeScript migration devam ediyor, Vue daha güvenli" diyordu. Sprint 26'da strict:true tamamlandı — bu engel ortadan kalktı.

| Kriter | Vue 3 | Svelte 5 | Karar |
|--------|-------|----------|-------|
| Bundle artışı | +22 KB runtime (gzip) | ~0 (derleme zamanı) | ✅ Svelte |
| esbuild uyumu | ⚠️ Vite baskısı zamanla artar | ✅ `esbuild-svelte` doğrudan | ✅ Svelte |
| Kademeli benimseme | ✅ Ada yaklaşımı | ✅ Ada yaklaşımı | Beraberlik |
| TypeScript | ✅ Güçlü | ✅ Built-in, `.svelte` içinde `lang="ts"` | Beraberlik |
| Scoped CSS | ✅ `<style scoped>` | ✅ Otomatik, zero-config | Beraberlik |
| Mevcut `state.js` uyumu | Pinia gerektirir | `$state` rune — doğrudan karşılık | ✅ Svelte |
| Test | Vue Test Utils | `@testing-library/svelte` | Beraberlik |

**Belirleyici faktörler:**

1. **Bundle büyümez.** Bridge'in `chunk-boot` + 7 paralel chunk mimarisi Svelte'in derleme-zamanı çıktısıyla doğrudan uyumlu. Vue runtime her kullanıcıya +22 KB ekler — bu, ses/video yüklü bir uygulamada kabul edilemez bir trade-off.

2. **esbuild pipeline korunur.** Vue ekosistemi fiilen Vite'a kilitli; `esbuild-plugin-vue` community destekli ve production'da daha az test edilmiş. `esbuild-svelte` ise Svelte ekibinin birincil CLI çıktı yolu.

3. **Runes, mevcut state pattern'ını karşılar.** `core/state.ts`'deki `getCurrentUser()`, `getCurrentChannel()` gibi fonksiyonlar Svelte `$state` + `$derived` ile bire bir karşılık bulur; Pinia migration gerektirmez.

4. **Svelte 5 GA çıktı.** Taslak yazılırken "hâlâ yeni" riski vardı. Sprint 38 itibarıyla Svelte 5 stable release olarak değerlendiriliyor.

---

## Migration Planı

### Felsefe: Ada Yaklaşımı (Island Strategy)

Mevcut `client/js/core/` dosyalarına dokunulmaz. Yeni bileşenler `.svelte` olarak yazılır; mevcut dosyalar kendi sprint'lerinde dönüştürülür. Her ada izole — `BridgeRegistry` üzerinden Vanilla JS ile haberleşir.

### Faz 0 — Altyapı (Sprint 39)

```bash
# server/package.json değil, root package.json'a:
npm install --save-dev esbuild-svelte svelte @testing-library/svelte
```

`scripts/build.js` (veya esbuild config) güncellenir:

```js
// scripts/build.js
import { esbuildSvelte } from 'esbuild-svelte';

await esbuild.build({
  entryPoints: ['client/js/app.ts'],
  bundle: true,
  plugins: [
    esbuildSvelte({
      compilerOptions: { css: 'injected', runes: true },
    }),
  ],
  splitting: true,
  format: 'esm',
  outdir: 'client/dist/js',
});
```

CI'ya `typecheck:svelte` adımı eklenir:

```yaml
# .github/workflows/ci.yml
- name: Svelte typecheck
  run: npx svelte-check --tsconfig ./client/tsconfig.json
```

**Kabul kriteri:** Mevcut build bozulmaz, yeni `.svelte` dosyaları derlenir.

---

### Faz 1 — İlk Ada: SettingsModal (Sprint 39-40)

`client/js/core/settings-modal.ts` (726 satır) ilk pilot bileşen. Karmaşık, test edilmemiş, DOM manipulation yoğun — kazanım büyük.

```
client/js/core/settings/
  SettingsModal.svelte       ← ana bileşen
  tabs/
    ProfileTab.svelte
    AppearanceTab.svelte
    NotificationsTab.svelte
    PrivacyTab.svelte
    DevicesTab.svelte         ← ses/video cihaz seçimi
  stores/
    settingsStore.ts          ← $state ile mevcut state.ts'den türer
```

`BridgeRegistry` köprüsü (Vanilla JS tarafı değişmez):

```ts
// client/js/core/settings-modal.ts — sadece bu kalır
import { mount } from 'svelte';
import SettingsModal from './settings/SettingsModal.svelte';

BridgeRegistry.register('openSettingsModal', (tab?: string) => {
  const target = document.getElementById('settings-mount');
  if (!target) return;
  mount(SettingsModal, { target, props: { initialTab: tab } });
});
```

**Kabul kriteri:** `settings-modal.ts` 726 satırdan <50 satıra iner. Var olan davranış değişmez. `@testing-library/svelte` ile ilk component test'ler yazılır.

---

### Faz 2 — Yüksek Değerli Adalar (Sprint 40-42)

Öncelik sırası (boyut + karmaşıklık + test eksikliği):

| Dosya | Satır | Svelte Hedefi |
|-------|-------|---------------|
| `bot-marketplace.js` | ~1400 (50KB) | `BotMarketplace.svelte` |
| `voice.js` | 707 | `VoicePanel.svelte` |
| `dm.ts` | ~600 | `DmPanel.svelte` |
| `channel-perms/` (4 dosya) | ~800 toplam | `ChannelPermsModal.svelte` |

Her ada kendi sprint'ine sığmalı. Birden fazla dosyayı aynı anda taşıma.

---

### Faz 3 — `chunk-core` Konsolidasyonu (Sprint 43+)

`client/js/core/` altındaki küçük utility dosyaları (80+ dosya) değerlendirilir:

- Framework-agnostic olanlar (api-fetch, utils, socket-events) — Vanilla TS olarak kalır
- UI logic içerenler — ada olarak sarmalanır veya Svelte store'a dönüştürülür
- `BridgeRegistry` sonunda kaldırılır; Svelte context API alır

Bu faz, e2e testlerin tam yeşil olması şartına bağlı.

---

## Reddedilen Alternatifler

| Seçenek | Red gerekçesi |
|---------|---------------|
| Vue 3 | +22 KB runtime; esbuild pipeline riski; Pinia migration maliyeti |
| React | Bundle boyutu, mevcut DOM pattern uyumsuzluğu |
| SvelteKit / Nuxt | SSR gerektirmiyor, overkill |
| Vanilla JS devam | CSS scoping yok; bileşen test yazılamıyor; borç büyüyor |

---

## Riskler ve Azaltma

| Risk | Olasılık | Azaltma |
|------|----------|---------|
| Svelte 5 API değişikliği | Düşük (stable) | `package.json`'da `"svelte": "^5.x"` — minor patch takip |
| `esbuild-svelte` bug | Orta | Faz 0'da CI benchmark; fallback: Vite ile paralel build |
| Ada köprüsü (BridgeRegistry) boilerplate | Düşük | Faz 1 sonunda şablon sabitleşir |
| Ekip öğrenme eğrisi | Orta | Faz 1 tek dosya — öğrenme maliyeti izole |

---

## Sonraki Adımlar

- [ ] **Sprint 39 Faz 0:** `esbuild-svelte` kurulum, CI adımı, build smoke test
- [ ] **Sprint 39 Faz 1 başlangıç:** `settings-modal.ts` → `SettingsModal.svelte` taşıması
- [ ] **Sprint 40:** Faz 1 tamamlama + ilk `@testing-library/svelte` testler
- [ ] **Sprint 40:** `bot-marketplace.js` Faz 2 pilot
- [ ] **Sprint 43:** Faz 3 kapsamı değerlendirmesi (e2e tam yeşil şartıyla)

---

*Bu ADR ADR-0001 formatını takip eder. Durum değişikliği: Taslak → Kabul Edildi (Sprint 38)*
