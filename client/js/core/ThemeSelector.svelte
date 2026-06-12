<!-- client/js/core/ThemeSelector.svelte -->
<!-- Sprint 116 — themes.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Tema seçici ve özel tema -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ThemeSelector');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showThemeSelector', () => { isVisible = true; });
    BridgeRegistry.register('hideThemeSelector', () => { isVisible = false; });
    isReady = true;
    log.info('ThemeSelector mounted');
  });
  onDestroy(() => {
    log.info('ThemeSelector destroyed');
  });
</script>

{#if isVisible}
<div class="theme-selector" role="region" aria-label="Tema seçici ve özel tema">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.theme-selector {
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
