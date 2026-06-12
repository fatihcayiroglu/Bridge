<!-- client/js/core/MobileUXManager.svelte -->
<!-- Sprint 116 — mobile-ux.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Mobil UX iyileştirmeleri yöneticisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('MobileUXManager');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showMobileUXManager', () => { isVisible = true; });
    BridgeRegistry.register('hideMobileUXManager', () => { isVisible = false; });
    isReady = true;
    log.info('MobileUXManager mounted');
  });
  onDestroy(() => {
    log.info('MobileUXManager destroyed');
  });
</script>

{#if isVisible}
<div class="mobile-u-x-manager" role="region" aria-label="Mobil UX iyileştirmeleri yöneticisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.mobile-u-x-manager {
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
