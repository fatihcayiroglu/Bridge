<!-- client/js/core/AnalyticsDashboard.svelte -->
<!-- Sprint 116 — analytics-dashboard.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Sunucu analitik gösterge paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('AnalyticsDashboard');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showAnalyticsDashboard', () => { isVisible = true; });
    BridgeRegistry.register('hideAnalyticsDashboard', () => { isVisible = false; });
    isReady = true;
    log.info('AnalyticsDashboard mounted');
  });
  onDestroy(() => {
    log.info('AnalyticsDashboard destroyed');
  });
</script>

{#if isVisible}
<div class="analytics-dashboard" role="region" aria-label="Sunucu analitik gösterge paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.analytics-dashboard {
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
