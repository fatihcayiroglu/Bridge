<!-- client/js/core/PartialsManager.svelte -->
<!-- Sprint 116 — partials.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Kısmi HTML şablonları yöneticisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('PartialsManager');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showPartialsManager', () => { isVisible = true; });
    BridgeRegistry.register('hidePartialsManager', () => { isVisible = false; });
    isReady = true;
    log.info('PartialsManager mounted');
  });
  onDestroy(() => {
    log.info('PartialsManager destroyed');
  });
</script>

{#if isVisible}
<div class="partials-manager" role="region" aria-label="Kısmi HTML şablonları yöneticisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.partials-manager {
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
