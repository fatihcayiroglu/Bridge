<!-- client/js/core/ActivityPanel.svelte -->
<!-- Sprint 116 — activity.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Kullanıcı aktivite gösterimi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ActivityPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showActivityPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideActivityPanel', () => { isVisible = false; });
    isReady = true;
    log.info('ActivityPanel mounted');
  });
  onDestroy(() => {
    log.info('ActivityPanel destroyed');
  });
</script>

{#if isVisible}
<div class="activity-panel" role="region" aria-label="Kullanıcı aktivite gösterimi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.activity-panel {
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
