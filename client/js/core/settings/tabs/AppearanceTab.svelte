<!-- client/js/core/settings/tabs/AppearanceTab.svelte -->
<script lang="ts">
  import type { SettingsStore } from '../stores/settingsStore';
  import {
    getLayoutMode,
    setLayoutMode,
    type BridgeLayoutMode,
  } from '../../layout-prefs';

  let { store }: { store: SettingsStore } = $props();

  const THEMES = [
    { id: 'dark',   label: 'Koyu',    preview: '#0f1419' },
    { id: 'light',  label: 'Açık',    preview: '#f2f3f5' },
    { id: 'amoled', label: 'AMOLED',  preview: '#000000' },
    { id: 'aurora', label: 'Aurora',  preview: 'linear-gradient(135deg,#0f1419,#1a3a4a)' },
  ];

  const LAYOUTS: { id: BridgeLayoutMode; label: string; desc: string }[] = [
    { id: 'classic', label: 'Klasik', desc: 'Hub + Space listesi + sohbet' },
    { id: 'focus',   label: 'Odak',   desc: 'Sohbet öncelikli — dar hub rail' },
    { id: 'compact', label: 'Kompakt', desc: 'Dar paneller, daha fazla içerik alanı' },
  ];

  let selectedTheme = $state(localStorage.getItem('bridge:theme') ?? 'dark');
  let selectedLayout = $state(getLayoutMode());

  function applyTheme(id: string) {
    selectedTheme = id;
    localStorage.setItem('bridge:theme', id);
    document.documentElement.setAttribute('data-theme', id);
  }

  function applyLayout(id: BridgeLayoutMode) {
    selectedLayout = id;
    setLayoutMode(id);
  }
</script>

<section aria-labelledby="appearance-heading">
  <h2 id="appearance-heading" class="section-title">Görünüm</h2>

  <fieldset class="theme-group">
    <legend class="field-label">Tema</legend>
    <div class="theme-options">
      {#each THEMES as theme (theme.id)}
        <button
          class="theme-btn"
          class:selected={selectedTheme === theme.id}
          aria-pressed={selectedTheme === theme.id}
          onclick={() => applyTheme(theme.id)}
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
    <legend class="field-label">Düzen</legend>
    <p class="field-hint">Bridge kendi arayüz düzenini kullanır — Discord kopyası değildir.</p>
    <div class="layout-options">
      {#each LAYOUTS as layout (layout.id)}
        <button
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
</section>

<style>
  .section-title { font-size: 20px; font-weight: 700; margin: 0 0 24px; color: var(--text-primary, #e4e6eb); }
  .field-label { display: block; font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--text-muted, #6d6f78); margin-bottom: 12px; }
  .field-hint { font-size: 13px; color: var(--text-muted, #6d6f78); margin: -6px 0 14px; line-height: 1.45; }
  .theme-group { border: none; padding: 0; margin: 0 0 28px; }
  .theme-options { display: flex; flex-wrap: wrap; gap: 12px; }
  .theme-btn { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 12px 16px; border: 2px solid transparent; border-radius: 8px; background: var(--bg-secondary, #141517); color: var(--text-secondary, #b0b3bb); font-size: 13px; cursor: pointer; transition: border-color 0.15s; }
  .theme-btn.selected { border-color: var(--brand, #2d9cdb); color: var(--text-primary, #e4e6eb); }
  .theme-preview { width: 48px; height: 48px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.08); }
  .layout-options { display: flex; flex-direction: column; gap: 8px; }
  .layout-btn { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 12px 14px; border: 2px solid transparent; border-radius: 8px; background: var(--bg-secondary, #141517); color: var(--text-secondary, #b0b3bb); cursor: pointer; text-align: left; width: 100%; max-width: 420px; }
  .layout-btn.selected { border-color: var(--accent, #f5a623); background: var(--brand-bg-low, rgba(45,156,219,.07)); color: var(--text-primary, #e4e6eb); }
  .layout-label { font-size: 14px; font-weight: 700; }
  .layout-desc { font-size: 12px; opacity: 0.85; }
</style>
