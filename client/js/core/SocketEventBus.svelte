<!-- client/js/core/SocketEventBus.svelte -->
<!-- Sprint 116 — socket-events.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Socket event bus ve yönlendirici -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('SocketEventBus');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showSocketEventBus', () => { isVisible = true; });
    BridgeRegistry.register('hideSocketEventBus', () => { isVisible = false; });
    isReady = true;
    log.info('SocketEventBus mounted');
  });
  onDestroy(() => {
    log.info('SocketEventBus destroyed');
  });
</script>

{#if isVisible}
<div class="socket-event-bus" role="region" aria-label="Socket event bus ve yönlendirici">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.socket-event-bus {
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
