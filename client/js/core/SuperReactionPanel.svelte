<!-- client/js/core/SuperReactionPanel.svelte -->
<!-- Sprint 116 — super-reactions.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Animasyonlu süper reaksiyon paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('SuperReactionPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showSuperReactionPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideSuperReactionPanel', () => { isVisible = false; });
    isReady = true;
    log.info('SuperReactionPanel mounted');
  });
  onDestroy(() => {
    log.info('SuperReactionPanel destroyed');
  });
</script>

{#if isVisible}
<div class="super-reaction-panel" role="region" aria-label="Animasyonlu süper reaksiyon paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.super-reaction-panel {
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
