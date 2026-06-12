<!-- client/js/core/ServerPanel.svelte -->
<!-- Sprint 116 — server-ui.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Sunucu ana panel ve sidebar -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ServerPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showServerPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideServerPanel', () => { isVisible = false; });
    isReady = true;
    log.info('ServerPanel mounted');
  });
  onDestroy(() => {
    log.info('ServerPanel destroyed');
  });
</script>

{#if isVisible}
<div class="server-panel" role="region" aria-label="Sunucu ana panel ve sidebar">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.server-panel {
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
