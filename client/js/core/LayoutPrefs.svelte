<!-- client/js/core/LayoutPrefs.svelte -->
<!-- Sprint 116 — layout-prefs.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Kullanıcı layout tercihleri yöneticisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('LayoutPrefs');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showLayoutPrefs', () => { isVisible = true; });
    BridgeRegistry.register('hideLayoutPrefs', () => { isVisible = false; });
    isReady = true;
    log.info('LayoutPrefs mounted');
  });
  onDestroy(() => {
    log.info('LayoutPrefs destroyed');
  });
</script>

{#if isVisible}
<div class="layout-prefs" role="region" aria-label="Kullanıcı layout tercihleri yöneticisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.layout-prefs {
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
