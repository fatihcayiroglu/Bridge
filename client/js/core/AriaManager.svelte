<!-- client/js/core/AriaManager.svelte -->
<!-- Sprint 116 — a11y-aria.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- ARIA canlı bölge ve rol yöneticisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('AriaManager');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showAriaManager', () => { isVisible = true; });
    BridgeRegistry.register('hideAriaManager', () => { isVisible = false; });
    isReady = true;
    log.info('AriaManager mounted');
  });
  onDestroy(() => {
    log.info('AriaManager destroyed');
  });
</script>

{#if isVisible}
<div class="aria-manager" role="region" aria-label="ARIA canlı bölge ve rol yöneticisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.aria-manager {
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
