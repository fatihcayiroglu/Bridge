<!-- client/js/core/BridgeSelect.svelte -->
<!-- Sprint 116 — bridge-ui-select.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Bridge tasarım sistemi seçici bileşeni -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('BridgeSelect');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showBridgeSelect', () => { isVisible = true; });
    BridgeRegistry.register('hideBridgeSelect', () => { isVisible = false; });
    isReady = true;
    log.info('BridgeSelect mounted');
  });
  onDestroy(() => {
    log.info('BridgeSelect destroyed');
  });
</script>

{#if isVisible}
<div class="bridge-select" role="region" aria-label="Bridge tasarım sistemi seçici bileşeni">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.bridge-select {
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
