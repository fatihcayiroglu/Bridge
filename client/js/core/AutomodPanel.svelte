<!-- client/js/core/AutomodPanel.svelte -->
<!-- Sprint 116 — automod.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Otomatik moderasyon kural yönetimi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('AutomodPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showAutomodPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideAutomodPanel', () => { isVisible = false; });
    isReady = true;
    log.info('AutomodPanel mounted');
  });
  onDestroy(() => {
    log.info('AutomodPanel destroyed');
  });
</script>

{#if isVisible}
<div class="automod-panel" role="region" aria-label="Otomatik moderasyon kural yönetimi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.automod-panel {
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
