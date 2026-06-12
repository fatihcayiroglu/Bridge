<!-- client/js/core/ClydeAssistant.svelte -->
<!-- Sprint 116 — clyde.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Bridge AI asistan bileşeni -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ClydeAssistant');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showClydeAssistant', () => { isVisible = true; });
    BridgeRegistry.register('hideClydeAssistant', () => { isVisible = false; });
    isReady = true;
    log.info('ClydeAssistant mounted');
  });
  onDestroy(() => {
    log.info('ClydeAssistant destroyed');
  });
</script>

{#if isVisible}
<div class="clyde-assistant" role="region" aria-label="Bridge AI asistan bileşeni">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.clyde-assistant {
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
