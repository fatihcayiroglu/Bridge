<!-- client/js/core/ThemeManager.svelte -->
<!-- Sprint 116 — theme.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Tema ve renk şeması yöneticisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ThemeManager');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showThemeManager', () => { isVisible = true; });
    BridgeRegistry.register('hideThemeManager', () => { isVisible = false; });
    isReady = true;
    log.info('ThemeManager mounted');
  });
  onDestroy(() => {
    log.info('ThemeManager destroyed');
  });
</script>

{#if isVisible}
<div class="theme-manager" role="region" aria-label="Tema ve renk şeması yöneticisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.theme-manager {
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
