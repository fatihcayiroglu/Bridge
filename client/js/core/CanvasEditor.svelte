<!-- client/js/core/CanvasEditor.svelte -->
<!-- Sprint 116 — canvas.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Collaborative whiteboard canvas -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('CanvasEditor');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showCanvasEditor', () => { isVisible = true; });
    BridgeRegistry.register('hideCanvasEditor', () => { isVisible = false; });
    isReady = true;
    log.info('CanvasEditor mounted');
  });
  onDestroy(() => {
    log.info('CanvasEditor destroyed');
  });
</script>

{#if isVisible}
<div class="canvas-editor" role="region" aria-label="Collaborative whiteboard canvas">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.canvas-editor {
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
