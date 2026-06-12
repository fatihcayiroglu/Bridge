<!-- client/js/core/SettingsManager.svelte -->
<!-- Sprint 116 — settings.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Kullanıcı ayarları yöneticisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('SettingsManager');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showSettingsManager', () => { isVisible = true; });
    BridgeRegistry.register('hideSettingsManager', () => { isVisible = false; });
    isReady = true;
    log.info('SettingsManager mounted');
  });
  onDestroy(() => {
    log.info('SettingsManager destroyed');
  });
</script>

{#if isVisible}
<div class="settings-manager" role="region" aria-label="Kullanıcı ayarları yöneticisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.settings-manager {
  display: flex;
  flex-direction: column;
  background: var(--bridge-surface, #1e2124);
  color: var(--bridge-text, #fff);
  border-radius: 8px;
}
.bridge-error {
  padding: 12px;
  color: var(--bridge-danger, #f04747);
  font-size: .875rem;
  text-align: center;
}
</style>
