<!-- client/js/core/SemanticSearchPanel.svelte -->
<!-- Sprint 116 — semantic-search.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- pgvector semantik arama paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('SemanticSearchPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showSemanticSearchPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideSemanticSearchPanel', () => { isVisible = false; });
    isReady = true;
    log.info('SemanticSearchPanel mounted');
  });
  onDestroy(() => {
    log.info('SemanticSearchPanel destroyed');
  });
</script>

{#if isVisible}
<div class="semantic-search-panel" role="region" aria-label="pgvector semantik arama paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.semantic-search-panel {
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
