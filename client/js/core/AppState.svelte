<!-- client/js/core/AppState.svelte -->
<!-- Sprint 116 — state.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Global uygulama durumu yöneticisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('AppState');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showAppState', () => { isVisible = true; });
    BridgeRegistry.register('hideAppState', () => { isVisible = false; });
    isReady = true;
    log.info('AppState mounted');
  });
  onDestroy(() => {
    log.info('AppState destroyed');
  });
</script>

{#if isVisible}
<div class="app-state" role="region" aria-label="Global uygulama durumu yöneticisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.app-state {
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
