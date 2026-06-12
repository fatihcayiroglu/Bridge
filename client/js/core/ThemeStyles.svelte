<!-- client/js/core/ThemeStyles.svelte -->
<!-- Sprint 116 — styles.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Dinamik CSS değişken yöneticisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ThemeStyles');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showThemeStyles', () => { isVisible = true; });
    BridgeRegistry.register('hideThemeStyles', () => { isVisible = false; });
    isReady = true;
    log.info('ThemeStyles mounted');
  });
  onDestroy(() => {
    log.info('ThemeStyles destroyed');
  });
</script>

{#if isVisible}
<div class="theme-styles" role="region" aria-label="Dinamik CSS değişken yöneticisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.theme-styles {
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
