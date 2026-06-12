<!-- client/js/core/ApiErrorToast.svelte -->
<!-- Sprint 116 — api-error-toast.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- API hata bildirim toast bileşeni -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ApiErrorToast');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showApiErrorToast', () => { isVisible = true; });
    BridgeRegistry.register('hideApiErrorToast', () => { isVisible = false; });
    isReady = true;
    log.info('ApiErrorToast mounted');
  });
  onDestroy(() => {
    log.info('ApiErrorToast destroyed');
  });
</script>

{#if isVisible}
<div class="api-error-toast" role="region" aria-label="API hata bildirim toast bileşeni">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.api-error-toast {
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
