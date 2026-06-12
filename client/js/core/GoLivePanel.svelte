<!-- client/js/core/GoLivePanel.svelte -->
<!-- Sprint 116 — go-live.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Go Live / Ekran paylaşımı yayın paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('GoLivePanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showGoLivePanel', () => { isVisible = true; });
    BridgeRegistry.register('hideGoLivePanel', () => { isVisible = false; });
    isReady = true;
    log.info('GoLivePanel mounted');
  });
  onDestroy(() => {
    log.info('GoLivePanel destroyed');
  });
</script>

{#if isVisible}
<div class="go-live-panel" role="region" aria-label="Go Live / Ekran paylaşımı yayın paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.go-live-panel {
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
