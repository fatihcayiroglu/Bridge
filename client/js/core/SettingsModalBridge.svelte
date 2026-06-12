<!-- client/js/core/SettingsModalBridge.svelte -->
<!-- Sprint 116 — settings-modal.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Ayarlar modal köprüsü -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('SettingsModalBridge');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showSettingsModalBridge', () => { isVisible = true; });
    BridgeRegistry.register('hideSettingsModalBridge', () => { isVisible = false; });
    isReady = true;
    log.info('SettingsModalBridge mounted');
  });
  onDestroy(() => {
    log.info('SettingsModalBridge destroyed');
  });
</script>

{#if isVisible}
<div class="settings-modal-bridge" role="region" aria-label="Ayarlar modal köprüsü">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.settings-modal-bridge {
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
