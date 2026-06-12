<!-- client/js/core/MiscUI.svelte -->
<!-- Sprint 116 — misc.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Çeşitli UI yardımcı bileşeni -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('MiscUI');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showMiscUI', () => { isVisible = true; });
    BridgeRegistry.register('hideMiscUI', () => { isVisible = false; });
    isReady = true;
    log.info('MiscUI mounted');
  });
  onDestroy(() => {
    log.info('MiscUI destroyed');
  });
</script>

{#if isVisible}
<div class="misc-u-i" role="region" aria-label="Çeşitli UI yardımcı bileşeni">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.misc-u-i {
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
