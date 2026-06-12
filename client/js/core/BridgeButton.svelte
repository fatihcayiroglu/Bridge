<!-- client/js/core/BridgeButton.svelte -->
<!-- Sprint 116 — bridge-ui-button.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Bridge tasarım sistemi buton bileşeni -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('BridgeButton');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showBridgeButton', () => { isVisible = true; });
    BridgeRegistry.register('hideBridgeButton', () => { isVisible = false; });
    isReady = true;
    log.info('BridgeButton mounted');
  });
  onDestroy(() => {
    log.info('BridgeButton destroyed');
  });
</script>

{#if isVisible}
<div class="bridge-button" role="region" aria-label="Bridge tasarım sistemi buton bileşeni">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.bridge-button {
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
