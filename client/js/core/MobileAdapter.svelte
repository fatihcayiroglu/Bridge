<!-- client/js/core/MobileAdapter.svelte -->
<!-- Sprint 116 — mobile.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Mobil platform uyarlama katmanı -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('MobileAdapter');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showMobileAdapter', () => { isVisible = true; });
    BridgeRegistry.register('hideMobileAdapter', () => { isVisible = false; });
    isReady = true;
    log.info('MobileAdapter mounted');
  });
  onDestroy(() => {
    log.info('MobileAdapter destroyed');
  });
</script>

{#if isVisible}
<div class="mobile-adapter" role="region" aria-label="Mobil platform uyarlama katmanı">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.mobile-adapter {
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
