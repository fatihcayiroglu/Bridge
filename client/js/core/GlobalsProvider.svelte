<!-- client/js/core/GlobalsProvider.svelte -->
<!-- Sprint 116 — globals.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Global değişken sağlayıcı -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('GlobalsProvider');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showGlobalsProvider', () => { isVisible = true; });
    BridgeRegistry.register('hideGlobalsProvider', () => { isVisible = false; });
    isReady = true;
    log.info('GlobalsProvider mounted');
  });
  onDestroy(() => {
    log.info('GlobalsProvider destroyed');
  });
</script>

{#if isVisible}
<div class="globals-provider" role="region" aria-label="Global değişken sağlayıcı">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.globals-provider {
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
