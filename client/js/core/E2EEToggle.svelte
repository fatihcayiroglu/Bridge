<!-- client/js/core/E2EEToggle.svelte -->
<!-- Sprint 116 — e2ee-toggle.ts → Svelte 5 Runes -->
<script lang="ts">
  import { t } from "./i18n/reactive.svelte.ts";
  import { onMount } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('E2EEToggle');

  interface Props { channelId: string; initialEnabled?: boolean; }
  let { channelId, initialEnabled = false }: Props = $props();
  function getInitialEnabled(): boolean {
    return Boolean(initialEnabled);
  }

  let enabled    = $state(getInitialEnabled());
  let isLoading  = $state(false);
  let error      = $state('');
  let featureOn  = $state(false);

  async function toggle() {
    if (!featureOn) return;
    isLoading = true; error = '';
    try {
      const apiFetch = BridgeRegistry.get<(url: string, init?: RequestInit) => Promise<Response>>('apiFetch');
      if (!apiFetch) throw new Error('API owner unavailable');
      const res = await apiFetch(`/api/channels/${channelId}/e2ee`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: !enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (typeof data?.e2eeEnabled !== 'boolean') throw new Error('Malformed E2EE response');
      enabled = data.e2eeEnabled;
      BridgeRegistry.call('toast',
        enabled ? t("ui_e2ee_etkinlestirildi", "E2EE etkinleştirildi 🔒") : t("ui_e2ee_devre_disi_birakildi", "E2EE devre dışı bırakıldı"),
        enabled ? 'success' : 'info');
      log.info('E2EE toggled', { channelId, enabled });
    } catch (err) {
      error = t("ui_e2ee_ayari_degistirilemedi", "E2EE ayarı değiştirilemedi");
      log.error('E2EE toggle failed', err);
    } finally {
      isLoading = false;
    }
  }

  onMount(async () => {
    try {
      const apiFetch = BridgeRegistry.get<(url: string, init?: RequestInit) => Promise<Response>>('apiFetch');
      if (!apiFetch) { featureOn = false; return; }
      const res = await apiFetch('/api/e2e/feature-status');
      if (!res.ok) { featureOn = false; return; }
      const data = await res.json();
      featureOn = data?.enabled === true;
    } catch { featureOn = false; }
  });
</script>

{#if featureOn}
<div class="e2ee-toggle" class:enabled>
  <button
    class="e2ee-btn"
    onclick={toggle}
    disabled={isLoading}
    aria-pressed={enabled}
    aria-label={enabled ? t("surface_e2ee_kapat_1d84c5") : t("surface_e2ee_ac_ec5b44")}
    title={enabled ? t("surface_uctan_uca_sifreleme_aktif_kapatmak_icin_t_kl_066b14") : t("surface_uctan_uca_sifrelemeyi_etkinlestir_1e8b62")}
  >
    <span class="e2ee-icon" aria-hidden="true">{enabled ? '🔒' : '🔓'}</span>
    <span class="e2ee-label">E2EE {enabled ? t("ui_acik") : t("ui_kapali")}</span>
    {#if isLoading}
      <span class="e2ee-spinner" aria-hidden="true"></span>
    {:else}
      <span class="e2ee-switch" class:on={enabled} aria-hidden="true"></span>
    {/if}
  </button>
  {#if error}
    <span class="e2ee-error" role="alert">{error}</span>
  {/if}
</div>
{/if}

<style>
.e2ee-toggle { display: flex; flex-direction: column; gap: 4px; }
.e2ee-btn {
  display: inline-flex; align-items: center; gap: 6px;
  background: var(--bridge-surface2, #232636); border: none; cursor: pointer;
  padding: 5px 10px; border-radius: 6px; transition: background .12s;
  color: var(--bridge-muted, #8a91ad); font-size: .8rem;
}
.e2ee-btn:hover:not(:disabled) { background: var(--bridge-surface3, #2c3048); }
.e2ee-btn:disabled { opacity: .5; cursor: default; }
.enabled .e2ee-btn { color: var(--bridge-green, #2ecc9a); }
.e2ee-icon { font-size: .9rem; }
.e2ee-switch {
  width: 28px; height: 14px; border-radius: 7px;
  background: var(--bridge-surface4, #363b54); position: relative; transition: background .2s;
}
.e2ee-switch::after {
  content: ''; position: absolute; top: 2px; left: 2px;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--text-on-solid); transition: left .2s;
}
.e2ee-switch.on { background: var(--bridge-green, #2ecc9a); }
.e2ee-switch.on::after { left: 16px; }
.e2ee-error { font-size: .75rem; color: var(--bridge-danger, #e05260); }
.e2ee-spinner {
  width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--text-primary) 30%, transparent); border-top-color: var(--text-primary);
  animation: spin .6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
</style>
