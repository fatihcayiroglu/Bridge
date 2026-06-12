<!-- client/js/core/AnalyticsTracker.svelte -->
<!-- Sprint 116 — analytics.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Kullanıcı analitik takipçisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('AnalyticsTracker');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showAnalyticsTracker', () => { isVisible = true; });
    BridgeRegistry.register('hideAnalyticsTracker', () => { isVisible = false; });
    isReady = true;
    log.info('AnalyticsTracker mounted');
  });
  onDestroy(() => {
    log.info('AnalyticsTracker destroyed');
  });
</script>

{#if isVisible}
<div class="analytics-tracker" role="region" aria-label="Kullanıcı analitik takipçisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.analytics-tracker {
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
