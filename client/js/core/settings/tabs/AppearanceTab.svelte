<!-- client/js/core/settings/tabs/AppearanceTab.svelte -->
<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import type { SettingsStore } from '../stores/settingsStore';
  import { BridgeRegistry } from '../../bridge-registry';
  import {
    THEMES,
    THEME_LABEL_KEYS,
    currentTheme,
    isTheme,
    type ThemeId,
  } from '../../theme-store';
  import {
    getLayoutMode,
    setLayoutMode,
    type BridgeLayoutMode,
  } from '../../layout-prefs';
  // Faz 12 sonrası — DİL SEÇİCİ.
  // 10 dillik çeviri tabloları ve `setLocale` zaten vardı; eksik olan tek şey
  // kullanıcının dili seçebileceği erişilebilir bir kontroldü.
  import { SUPPORTED_LOCALES, locale, setLocale, type Locale } from '../../i18n/index.ts';

  let { store: _store }: { store: SettingsStore } = $props();

  const THEME_PREVIEWS: Record<ThemeId, string> = {
    dark:     'linear-gradient(135deg, #0f1117 0 50%, #2d9cdb 50%)',
    light:    'linear-gradient(135deg, #ffffff 0 50%, #d6daf0 50%)',
    amoled:   'linear-gradient(135deg, #000000 0 50%, #181c2a 50%)',
    aurora:   'linear-gradient(135deg, #07110f 0 50%, #1bc8a8 50%)',
    midnight: 'linear-gradient(135deg, #060814 0 50%, #6674f4 50%)',
  };

  const THEME_OPTIONS = $derived(THEMES.map(id => ({
    id,
    label: t(THEME_LABEL_KEYS[id]),
    preview: THEME_PREVIEWS[id],
  })));

  // Yalnızca gerçekten desteklenen diller listelenir (i18n/index.ts:13).
  const LOCALE_OPTIONS = (Object.entries(SUPPORTED_LOCALES) as [Locale, string][])
    .map(([id, label]) => ({ id, label }));

  let selectedLocale = $state<Locale>(locale.current);
  let localeBusy     = $state(false);

  // Dil başka bir yerden değişirse (ör. başka bir akış) seçici senkron kalır.
  // Abonelik onDestroy'da bırakılır — kapatılan modal bayat dinleyici bırakmaz.
  const stopLocaleSub = locale.subscribe(loc => { selectedLocale = loc; });

  async function onLocaleChange(event: Event): Promise<void> {
    const next = (event.currentTarget as HTMLSelectElement).value as Locale;
    if (next === locale.current) return;
    localeBusy = true;
    try {
      // setLocale tabloyu yükler, localStorage['bridge_locale']'e yazar,
      // <html lang> günceller ve aboneleri bilgilendirir — DOM uygulayıcısı
      // bu aboneliğe bağlı olduğu için çeviriler anında yenilenir.
      await setLocale(next);
    } finally {
      localeBusy = false;
    }
  }

  const LAYOUTS: { id: BridgeLayoutMode; label: string; desc: string }[] = $derived.by(() => [
    { id: 'classic', label: t('ui_classic', 'Klasik'), desc: t('ui_classic_desc', 'Hub + Space listesi + sohbet') },
    { id: 'focus',   label: t('ui_focus', 'Odak'),   desc: t("ui_sohbet_oncelikli_dar_hub_rail", "Sohbet öncelikli — dar hub rail") },
    { id: 'compact', label: t('ui_compact', 'Kompakt'), desc: t("ui_dar_paneller_daha_fazla_icerik_alani", "Dar paneller, daha fazla içerik alanı") },
  ]);

  // ThemeManager/theme-store is the single owner of persistence and DOM state.
  // This tab only reflects that state and requests changes through its registry
  // contract; it must not create a second storage key or update one DOM root only.
  let selectedTheme = $state<ThemeId>(currentTheme());
  let selectedLayout = $state(getLayoutMode());
  let selectedDensity = $state<'comfortable' | 'compact'>(
    BridgeRegistry.call<'comfortable' | 'compact'>('getUiDensity') ?? 'comfortable',
  );

  function requestTheme(id: ThemeId) {
    BridgeRegistry.call('setTheme', id);
  }

  function onThemeChanged(event: Event) {
    const next = (event as CustomEvent<{ theme?: unknown }>).detail?.theme;
    if (isTheme(next)) selectedTheme = next;
  }

  function applyLayout(id: BridgeLayoutMode) {
    selectedLayout = id;
    setLayoutMode(id);
  }

  function applyDensity(id: 'comfortable' | 'compact') {
    selectedDensity = id;
    BridgeRegistry.call('setUiDensity', id);
  }

  onMount(() => {
    selectedTheme = currentTheme();
    document.addEventListener('bridge:theme-changed', onThemeChanged);
  });

  onDestroy(() => {
    document.removeEventListener('bridge:theme-changed', onThemeChanged);
    stopLocaleSub();
  });
</script>

<section aria-labelledby="appearance-heading">
  <h2 id="appearance-heading" class="section-title">{t('app_appearance', 'Görünüm')}</h2>

  <fieldset class="theme-group">
    <legend class="field-label">{t('markup_tema_6ae1bca', "Tema")}</legend>
    <div class="theme-options">
      {#each THEME_OPTIONS as theme (theme.id)}
        <button
          type="button"
          class="theme-btn"
          class:selected={selectedTheme === theme.id}
          aria-pressed={selectedTheme === theme.id}
          aria-label={t('theme_aria', undefined, { theme: theme.label })}
          onclick={() => requestTheme(theme.id)}
        >
          <span
            class="theme-preview"
            style="background:{theme.preview}"
          ></span>
          {theme.label}
        </button>
      {/each}
    </div>
  </fieldset>

  <fieldset class="theme-group layout-group">
    <legend class="field-label">{t('app_layout', 'Düzen')}</legend>
    <p class="field-hint">{t('app_layout_note', 'Bridge kendi arayüz düzenini kullanır — Discord kopyası değildir.')}</p>
    <div class="layout-options">
      {#each LAYOUTS as layout (layout.id)}
        <button
          type="button"
          class="layout-btn"
          class:selected={selectedLayout === layout.id}
          aria-pressed={selectedLayout === layout.id}
          onclick={() => applyLayout(layout.id)}
        >
          <span class="layout-label">{layout.label}</span>
          <span class="layout-desc">{layout.desc}</span>
        </button>
      {/each}
    </div>
  </fieldset>

  <!-- Yogunluk grubu, Duzen grubuyla AYNI siniflari tasiyordu; iki grup
       birbirinden ayirt edilemiyordu (ne bicemde ne de erisilebilirlik
       agacinda ne de testlerde). Kendi kancasini alir. -->
  <fieldset class="theme-group layout-group density-group">
    <legend class="field-label">{t("appearance_content_density")}</legend>
    <p class="field-hint">{t('markup_kompakt_mod_masaustunde_daha_fazla_sohbet_ve_kan_149babf', "Kompakt mod masaüstünde daha fazla sohbet ve kanal gösterir; dokunmatik hedefler küçültülmez.")}</p>
    <div class="layout-options">
      <button type="button" class="layout-btn" class:selected={selectedDensity === 'comfortable'}
              aria-pressed={selectedDensity === 'comfortable'} onclick={() => applyDensity('comfortable')}>
        <span class="layout-label">{t('markup_rahat_f39784b', "Rahat")}</span>
        <span class="layout-desc">{t("appearance_comfortable_hint")}</span>
      </button>
      <button type="button" class="layout-btn" class:selected={selectedDensity === 'compact'}
              aria-pressed={selectedDensity === 'compact'} onclick={() => applyDensity('compact')}>
        <span class="layout-label">{t('ui_compact')}</span>
        <span class="layout-desc">{t("appearance_compact_hint")}</span>
      </button>
    </div>
  </fieldset>

  <div class="form-group">
    <label class="field-label" for="locale-select">{t('markup_dil_e194b23', "Dil")}</label>
    <p class="field-hint">
      {t('markup_arayuz_dili_secim_bu_tarayicida_hatirlanir_42a93af', "Arayüz dili. Seçim bu tarayıcıda hatırlanır.")}
    </p>
    <select
      id="locale-select"
      class="locale-select"
      value={selectedLocale}
      disabled={localeBusy}
      onchange={onLocaleChange}
    >
      {#each LOCALE_OPTIONS as opt (opt.id)}
        <option value={opt.id}>{opt.label}</option>
      {/each}
    </select>
  </div>
</section>

<style>
  .section-title { margin: 0 0 24px; color: var(--text-primary); font: 750 var(--text-xl)/1.2 var(--font-display); }
  .field-label { display: block; margin-bottom: 12px; color: var(--text-muted); font: 700 var(--text-xs)/1.3 var(--font-sans); letter-spacing: .06em; text-transform: uppercase; }
  .field-hint { margin: -6px 0 14px; color: var(--text-muted); font-size: var(--text-sm); line-height: 1.45; }
  .theme-group { border: none; padding: 0; margin: 0 0 28px; }
  .theme-options { display: grid; grid-template-columns: repeat(auto-fit, minmax(88px, 1fr)); gap: 10px; max-width: 560px; }
  .theme-btn { display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 0; padding: 10px 12px; color: var(--text-secondary); font-size: var(--text-sm); cursor: pointer; background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-surface); transition: border-color var(--duration-fast), background var(--duration-fast), color var(--duration-fast), transform var(--duration-fast); }
  .theme-btn:hover { border-color: var(--border-strong); background: var(--bg-4); color: var(--text-primary); transform: translateY(-1px); }
  .theme-btn.selected { border-color: var(--brand); background: var(--brand-bg); color: var(--text-primary); box-shadow: inset 0 0 0 1px var(--brand-border); }
  .theme-preview { width: 100%; max-width: 64px; aspect-ratio: 1.35; border-radius: var(--radius-chip); border: 1px solid var(--border-strong); box-shadow: var(--shadow-xs); }
  .layout-options { display: flex; flex-direction: column; gap: 8px; }
  .layout-btn { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; width: 100%; max-width: 420px; padding: 12px 14px; color: var(--text-secondary); text-align: left; cursor: pointer; background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-surface); }
  .layout-btn:hover { color: var(--text-primary); background: var(--bg-hover); border-color: var(--border-strong); }
  .layout-btn.selected { color: var(--text-primary); background: var(--brand-bg-low); border-color: var(--brand-border); box-shadow: inset 3px 0 0 var(--brand); }
  .layout-label { font-size: var(--text-sm); font-weight: 700; }
  .layout-desc { font-size: var(--text-xs); opacity: .85; }
  .locale-select { width: 100%; max-width: 420px; padding: 10px 12px; color: var(--text-primary); font-size: var(--text-sm); background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-surface); cursor: pointer; }
  .locale-select:hover:not(:disabled) { border-color: var(--border-strong); background: var(--bg-4); }
  .locale-select:disabled { opacity: .6; cursor: progress; }
  .theme-btn:focus-visible,
  .layout-btn:focus-visible,
  .locale-select:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

  @media (max-width: 520px) {
    .theme-options { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  }

  @media (prefers-reduced-motion: reduce) {
    .theme-btn { transition: none; }
    .theme-btn:hover { transform: none; }
  }
</style>
