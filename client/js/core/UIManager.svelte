<!-- client/js/core/UIManager.svelte -->
<!-- Sprint 116 — ui.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Genel UI yönetim ve yardımcı bileşeni -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('UIManager');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showUIManager', () => { isVisible = true; });
    BridgeRegistry.register('hideUIManager', () => { isVisible = false; });
    isReady = true;
    log.info('UIManager mounted');
  });
  onDestroy(() => {
    log.info('UIManager destroyed');
  });
</script>

{#if isVisible}
<div class="u-i-manager" role="region" aria-label="Genel UI yönetim ve yardımcı bileşeni">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.u-i-manager {
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
