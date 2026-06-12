<!-- client/js/core/AdvancedSearchPanel.svelte -->
<!-- Sprint 116 — advanced-search.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Gelişmiş arama filtre paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('AdvancedSearchPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showAdvancedSearchPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideAdvancedSearchPanel', () => { isVisible = false; });
    isReady = true;
    log.info('AdvancedSearchPanel mounted');
  });
  onDestroy(() => {
    log.info('AdvancedSearchPanel destroyed');
  });
</script>

{#if isVisible}
<div class="advanced-search-panel" role="region" aria-label="Gelişmiş arama filtre paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.advanced-search-panel {
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
