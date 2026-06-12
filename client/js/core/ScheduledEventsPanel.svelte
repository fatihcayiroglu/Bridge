<!-- client/js/core/ScheduledEventsPanel.svelte -->
<!-- Sprint 116 — scheduled-ui.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Planlanmış etkinlikler paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ScheduledEventsPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showScheduledEventsPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideScheduledEventsPanel', () => { isVisible = false; });
    isReady = true;
    log.info('ScheduledEventsPanel mounted');
  });
  onDestroy(() => {
    log.info('ScheduledEventsPanel destroyed');
  });
</script>

{#if isVisible}
<div class="scheduled-events-panel" role="region" aria-label="Planlanmış etkinlikler paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.scheduled-events-panel {
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
